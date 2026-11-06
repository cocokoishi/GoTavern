// SELF-TEST FOR THE e03e04 INGREDIENT KIT. Run with: node tests/browser/extensions/e03e04-kit-selftest.mjs
//
// This is a THIN CLI over `e03e04-profile-kit.mjs`: it imports the module (no CLI parsing there, no top-level
// side effects there), builds the profiles, and asserts the kit's own contract. Exit code 0 ONLY if every check
// below passes; a single failure prints `FAIL <name>: <reason>` and exits 1.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the GENERATOR is deterministic, refuses malformed input by
// name, produces a 120+ block preset whose prompt_order references every declaration, marks enabled/disabled/
// trigger-excluded blocks unambiguously, and builds three world books with a documented recursive
// secondary-key chain. It proves NOTHING about the provider wire: no browser, no pinned boot, no network runs
// here, and no recorded fixture exists in this file (AGENTS.md rule 49). The claim it supports is exactly the
// M0 gap (E-H6/E-H7): the harness previously had no 120+ prompt preset and no nested/recursive world book; the
// committed maxima are stated below as a comparison against measured committed files.
//
// The negative controls named in the kit's header are NOT executed here; they belong to the comparator
// (`compare-combination-journey.mjs`) and to `combination-journey-gate-selftest.mjs`, and they must be observed
// red before the scenario is wired into CI (AGENTS.md rule 50 / differential doctrine rule 4).

import {
    ACTIVATION_TOKENS,
    BLOCK_MARKER_PATTERN,
    COMMITTED_MAXIMA,
    MAX_BLOCKS,
    PINNED_DEFAULT_PROMPTS,
    PROMPT_ORDER_DUMMY_ID,
    RecipeError,
    TIERS,
    WORLD_MARKER_FIND,
    WORLD_MARKER_PATTERN,
    buildBooks,
    buildPreset,
    buildProfile,
    buildSettingsPatch,
    canonicalJson,
    documentBytes,
    expectedOrder,
    presetProfile,
    sha256,
} from './e03e04-profile-kit.mjs';

const SEED = 'e03e04-alpha16-selftest';

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}
function assert(condition, message) {
    if (!condition) throw new Error(message);
}
function assertEqual(actual, expected, what) {
    assert(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}
function countIn(haystack, needle) {
    let count = 0;
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
        count += 1;
        index += needle.length;
    }
    return count;
}
function allMarkersIn(value) {
    return String(value).match(/MARKER_(?:P\d{4}|W[A-C]\d{4})/g) ?? [];
}

const profile120 = buildProfile({ seed: SEED, blockCount: TIERS.full, tier: 'full' });

// ---------------------------------------------------------------------------------------------------------------
// 1. THE STRESS PRESET BUILDS
// ---------------------------------------------------------------------------------------------------------------
check('blockcount-120-preset-builds', () => {
    const preset = buildPreset({ seed: SEED, blockCount: 120, tier: 'full' });
    assertEqual(preset.prompts.length, PINNED_DEFAULT_PROMPTS.length + 120, 'declared prompts');
    assertEqual(preset.prompt_order.length, 1, 'prompt_order entries');
    assertEqual(preset.prompt_order[0].character_id, PROMPT_ORDER_DUMMY_ID, 'prompt_order character_id (pinned dummyId)');
    assertEqual(preset.prompt_order[0].order.length, PINNED_DEFAULT_PROMPTS.length + 120, 'order length');
    assertEqual(preset.e03e04_profile.blockCount, 120, 'blockCount');
    assertEqual(preset.e03e04_profile.totalPromptCount, 132, 'total prompt count');
    const blocks = preset.prompts.filter(prompt => BLOCK_MARKER_PATTERN.test(String(prompt.content).match(/MARKER_P\d{4}/)?.[0] ?? ''));
    assertEqual(blocks.length, 120, 'marker-bearing generated blocks');
    // Reasoning/tool/schema and sampler members are present as declared.
    const required = ['temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'top_a', 'min_p',
        'repetition_penalty', 'openai_max_context', 'openai_max_tokens', 'seed', 'n', 'stream_openai',
        'reasoning_effort', 'verbosity', 'tool_reasoning_mode', 'function_calling', 'show_thoughts',
        'prompts', 'prompt_order', 'extensions'];
    for (const key of required) assert(Object.hasOwn(preset, key), `preset member ${key} is declared`);
    assert(preset.extensions.e03e04_profile, 'unknown-extension preservation canary is present');
    return { declared: preset.prompts.length, orderEntries: preset.prompt_order[0].order.length, blocks: blocks.length };
});

// ---------------------------------------------------------------------------------------------------------------
// 2. prompt_order MATCHES THE DECLARATIONS
// ---------------------------------------------------------------------------------------------------------------
check('prompt_order-matches-declarations', () => {
    const preset = buildPreset({ seed: SEED, blockCount: 120 });
    const declared = preset.prompts.map(prompt => prompt.identifier);
    const ordered = preset.prompt_order[0].order.map(entry => entry.identifier);
    assertEqual(new Set(declared).size, declared.length, 'declared identifiers are unique');
    assertEqual(new Set(ordered).size, ordered.length, 'ordered identifiers are unique');
    assertEqual(ordered.length, declared.length, 'order length equals declaration length');
    for (const identifier of declared) assert(ordered.includes(identifier), `declared prompt ${identifier} is referenced by prompt_order`);
    for (const identifier of ordered) assert(declared.includes(identifier), `ordered prompt ${identifier} is declared`);
    for (const entry of preset.prompt_order[0].order) assertEqual(typeof entry.enabled, 'boolean', `order entry ${entry.identifier}.enabled is boolean`);
    // The order is AUTHORED, not alphabetical: an implementation that sorted identifiers would pass a set
    // comparison but could never satisfy this.
    const sorted = declared.slice().sort();
    assert(JSON.stringify(ordered) !== JSON.stringify(sorted), 'prompt_order is an authored order, not the sorted identifier list');
    // No prompt after chatHistory: every marker-bearing relative block must precede the history anchor, which is
    // what the flat `sequence` claim depends on.
    const historyIndex = ordered.indexOf('chatHistory');
    assert(historyIndex === ordered.length - 2 || historyIndex === ordered.length - 1, `chatHistory sits near the end (index ${historyIndex} of ${ordered.length})`);
    return { declared: declared.length, authoredOrder: ordered.length };
});

// ---------------------------------------------------------------------------------------------------------------
// 3. ENABLED BLOCKS ARE IN THE MANIFEST; DISABLED/TRIGGER-EXCLUDED ARE NOT
// ---------------------------------------------------------------------------------------------------------------
check('enabled-blocks-present', () => {
    const order = expectedOrder({ preset: generatedPreset(), books: buildBooks({ seed: SEED }) });
    const sequenceMarkers = order.sequence.map(item => item.marker);
    for (const marker of order.blocks.enabledRelative) {
        assertEqual(countIn(sequenceMarkers.join(','), marker), 1, `enabled relative block ${marker} appears once in sequence`);
    }
    const absoluteMarkers = order.history.absoluteBlocks.flatMap(group => group.markers);
    for (const marker of order.blocks.enabledAbsolute) {
        assert(absoluteMarkers.includes(marker), `enabled absolute block ${marker} appears in history.absoluteBlocks`);
    }
    assert(order.blocks.enabledRelative.length > 0, 'there is at least one enabled relative block');
    assert(order.blocks.enabledAbsolute.length > 0, 'there is at least one enabled absolute block');
    return { relative: order.blocks.enabledRelative.length, absolute: order.blocks.enabledAbsolute.length };
});

check('disabled-blocks-absent', () => {
    const order = expectedOrder({ preset: generatedPreset(), books: buildBooks({ seed: SEED }) });
    assert(order.blocks.disabled.length > 0, 'the recipe declares disabled blocks');
    const presentOnly = JSON.stringify({ sequence: order.sequence, history: order.history, worldBooks: order.worldBooks });
    for (const marker of order.blocks.disabled) {
        assertEqual(countIn(presentOnly, marker), 0, `disabled block ${marker} is absent from every present bucket`);
        assert(order.absent.some(item => item.marker === marker), `disabled block ${marker} is named in the absent list`);
    }
    // The comparator will assert zero occurrences in the RECORDED body; the manifest must not contain the marker
    // in any "present" bucket, which is the part this module owns.
    return { disabled: order.blocks.disabled.length };
});

check('trigger-excluded-blocks-absent', () => {
    const order = expectedOrder({ preset: generatedPreset(), books: buildBooks({ seed: SEED }) });
    assert(order.blocks.triggerExcluded.length > 0, 'the recipe declares trigger-excluded blocks');
    const presentOnly = JSON.stringify({ sequence: order.sequence, history: order.history, worldBooks: order.worldBooks });
    for (const marker of order.blocks.triggerExcluded) {
        assertEqual(countIn(presentOnly, marker), 0, `trigger-excluded block ${marker} is absent from every present bucket`);
        assert(order.absent.some(item => item.marker === marker), `trigger-excluded block ${marker} is named in the absent list`);
    }
    return { triggerExcluded: order.blocks.triggerExcluded.length };
});

// ---------------------------------------------------------------------------------------------------------------
// 4. MARKER UNIQUENESS AND SHAPE
// ---------------------------------------------------------------------------------------------------------------
check('markers-unique', () => {
    const preset = generatedPreset();
    const bookSet = buildBooks({ seed: SEED });
    const blockMarkers = preset.e03e04_profile.blocks.map(block => block.marker);
    assertEqual(blockMarkers.length, 120, 'one marker per block');
    assertEqual(new Set(blockMarkers).size, 120, 'block markers are unique');
    for (const marker of blockMarkers) assert(BLOCK_MARKER_PATTERN.test(marker), `block marker ${marker} matches ${BLOCK_MARKER_PATTERN}`);
    for (const marker of blockMarkers) assertEqual(countIn(canonicalJson(preset.prompts), marker), 1, `block marker ${marker} appears once in the preset declarations`);

    const worldMarkers = [
        ...Object.values(bookSet.threeSlot.document.entries),
        ...Object.values(bookSet.recursiveGlobal.document.entries),
        ...bookSet.cardEmbedded.characterBook.entries,
    ].map(entry => String(entry.content).match(WORLD_MARKER_FIND)?.[0] ?? '');
    assertEqual(worldMarkers.length, 3 + 6 + 4, 'one marker per world entry');
    assertEqual(new Set(worldMarkers).size, worldMarkers.length, 'world markers are unique');
    for (const marker of worldMarkers) assert(WORLD_MARKER_PATTERN.test(marker), `world marker ${marker} matches ${WORLD_MARKER_PATTERN}`);

    const overlap = blockMarkers.filter(marker => worldMarkers.includes(marker));
    assertEqual(overlap.length, 0, 'block and world marker namespaces do not overlap');
    return { blockMarkers: blockMarkers.length, worldMarkers: worldMarkers.length };
});

// ---------------------------------------------------------------------------------------------------------------
// 5. TWO BUILDS ARE BYTE-IDENTICAL (same seed/count) -- the sha256s are printed
// ---------------------------------------------------------------------------------------------------------------
check('two-builds-byte-identical', () => {
    const first = buildProfile({ seed: SEED, blockCount: 120, tier: 'full' });
    const second = buildProfile({ seed: SEED, blockCount: 120, tier: 'full' });
    assertEqual(JSON.stringify(first.preset), JSON.stringify(second.preset), 'JSON.stringify(preset) is identical');
    assertEqual(documentBytes(first.preset), documentBytes(second.preset), 'canonical preset bytes are identical');
    assertEqual(JSON.stringify(first.books), JSON.stringify(second.books), 'books are identical');
    assertEqual(JSON.stringify(first.settings), JSON.stringify(second.settings), 'settings patch is identical');
    assertEqual(JSON.stringify(first.expectedOrder), JSON.stringify(second.expectedOrder), 'expectedOrder is identical');
    const firstPresetSha = sha256(canonicalJson(first.preset));
    const secondPresetSha = sha256(canonicalJson(second.preset));
    assertEqual(firstPresetSha, secondPresetSha, 'preset sha256');
    const firstOrderSha = sha256(canonicalJson(first.expectedOrder));
    const secondOrderSha = sha256(canonicalJson(second.expectedOrder));
    assertEqual(firstOrderSha, secondOrderSha, 'expectedOrder sha256');
    // Printed, not merely asserted: the report quotes these two identical digests.
    console.log(`    identical build #1 preset sha256 = ${firstPresetSha}`);
    console.log(`    identical build #2 preset sha256 = ${secondPresetSha}`);
    console.log(`    identical build #1 expectedOrder sha256 = ${firstOrderSha}`);
    console.log(`    identical build #2 expectedOrder sha256 = ${secondOrderSha}`);
    return { presetSha256: firstPresetSha, expectedOrderSha256: firstOrderSha };
});

// ---------------------------------------------------------------------------------------------------------------
// 6. EVERY TIER BUILDS: 12 / 60 / 120
// ---------------------------------------------------------------------------------------------------------------
check('tiers-12-60-120-build', () => {
    const results = {};
    for (const [tier, blockCount] of Object.entries(TIERS)) {
        const built = buildProfile({ seed: SEED, blockCount, tier });
        assertEqual(built.preset.e03e04_profile.blockCount, blockCount, `${tier} blockCount`);
        assertEqual(built.preset.prompts.length, PINNED_DEFAULT_PROMPTS.length + blockCount, `${tier} declared prompts`);
        assertEqual(built.preset.prompt_order[0].order.length, PINNED_DEFAULT_PROMPTS.length + blockCount, `${tier} order entries`);
        assertEqual(built.expectedOrder.blocks.enabledRelative.length + built.expectedOrder.blocks.enabledAbsolute.length + built.expectedOrder.absent.filter(item => item.marker.startsWith('MARKER_P')).length, blockCount, `${tier} block accounting`);
        results[tier] = { blockCount, totalPrompts: built.preset.prompts.length, sequence: built.expectedOrder.sequence.length };
    }
    // The full tier accepts 120+ (not merely 120): a 121-block recipe builds, so "120+" is a bound.
    const overFull = buildProfile({ seed: SEED, blockCount: TIERS.full + 1, tier: 'full' });
    assertEqual(overFull.preset.e03e04_profile.blockCount, 121, 'full tier accepts 120+ (121)');
    assertEqual(overFull.preset.prompts.length, PINNED_DEFAULT_PROMPTS.length + 121, '121-block profile declares 133 prompts');
    results.fullPlus = { blockCount: 121, totalPrompts: overFull.preset.prompts.length };
    return results;
});

// ---------------------------------------------------------------------------------------------------------------
// 7. THE COMMITTED MAXIMA ARE STATED, AND 120+ IS DEMONSTRATED AGAINST THEM
// ---------------------------------------------------------------------------------------------------------------
check('committed-maxima-and-120-plus-claim', () => {
    assertEqual(COMMITTED_MAXIMA.presetA.prompts, 105, 'committed preset-a prompt count');
    assertEqual(COMMITTED_MAXIMA.presetB.prompts, 119, 'committed preset-b prompt count');
    assertEqual(COMMITTED_MAXIMA.journeyCorpus.maxPrompts, 66, 'committed journey corpus max prompt count');
    const stress = buildPreset({ seed: SEED, blockCount: TIERS.full, tier: 'full' });
    const stressBlocks = stress.e03e04_profile.blockCount;
    const stressTotal = stress.prompts.length;
    // 120+ generated blocks AND more total prompts than either committed preset derivation.
    assert(stressBlocks >= 120, `the stress profile generates 120+ blocks (got ${stressBlocks})`);
    assert(stressTotal > COMMITTED_MAXIMA.presetB.prompts, `the stress profile declares more prompts than committed preset-b (${stressTotal} > ${COMMITTED_MAXIMA.presetB.prompts})`);
    assert(stressTotal > COMMITTED_MAXIMA.presetA.prompts, `the stress profile declares more prompts than committed preset-a (${stressTotal} > ${COMMITTED_MAXIMA.presetA.prompts})`);
    assert(stressTotal > COMMITTED_MAXIMA.journeyCorpus.maxPrompts, `the stress profile declares more prompts than the journey corpus (${stressTotal} > ${COMMITTED_MAXIMA.journeyCorpus.maxPrompts})`);
    console.log(`    committed maxima claim: preset-a ${COMMITTED_MAXIMA.presetA.prompts} prompts, preset-b ${COMMITTED_MAXIMA.presetB.prompts} prompts, journey corpus <= ${COMMITTED_MAXIMA.journeyCorpus.maxPrompts} prompts (M0, E-H6)`);
    console.log(`    120+ demonstration: ${stressBlocks} generated marker blocks + ${PINNED_DEFAULT_PROMPTS.length} pinned defaults = ${stressTotal} declared prompts, prompt_order references all ${stress.prompt_order[0].order.length}`);
    return { committed: { presetA: 105, presetB: 119, journey: 66 }, generated: stressBlocks, declared: stressTotal };
});

// ---------------------------------------------------------------------------------------------------------------
// 8. MALFORMED RECIPES ARE REFUSED WITH A NAMED ERROR (never silently degraded)
// ---------------------------------------------------------------------------------------------------------------
check('malformed-recipes-refused', () => {
    const cases = [
        ['null recipe', null, 'E03E04_RECIPE_NOT_AN_OBJECT'],
        ['array recipe', [], 'E03E04_RECIPE_NOT_AN_OBJECT'],
        ['missing seed', { blockCount: 12 }, 'E03E04_RECIPE_SEED_MISSING'],
        ['empty seed', { seed: '', blockCount: 12 }, 'E03E04_RECIPE_SEED_MISSING'],
        ['non-string seed', { seed: 42, blockCount: 12 }, 'E03E04_RECIPE_SEED_TYPE'],
        ['non-ASCII seed', { seed: 'h\u00e9llo', blockCount: 12 }, 'E03E04_RECIPE_SEED_CHARSET'],
        ['seed with a space', { seed: 'two words', blockCount: 12 }, 'E03E04_RECIPE_SEED_CHARSET'],
        ['missing blockCount', { seed: 'ok' }, 'E03E04_RECIPE_BLOCK_COUNT_MISSING'],
        ['fractional blockCount', { seed: 'ok', blockCount: 12.5 }, 'E03E04_RECIPE_BLOCK_COUNT_TYPE'],
        ['zero blockCount', { seed: 'ok', blockCount: 0 }, 'E03E04_RECIPE_BLOCK_COUNT_RANGE'],
        ['blockCount over MAX_BLOCKS', { seed: 'ok', blockCount: MAX_BLOCKS + 1 }, 'E03E04_RECIPE_BLOCK_COUNT_RANGE'],
        ['unknown field (typo would otherwise be ignored)', { seed: 'ok', blockCount: 12, blocks: 12 }, 'E03E04_RECIPE_UNKNOWN_FIELD'],
        ['unknown tier', { seed: 'ok', blockCount: 12, tier: 'ultra' }, 'E03E04_RECIPE_TIER_UNKNOWN'],
        ['tier/count disagreement', { seed: 'ok', blockCount: 13, tier: 'fast' }, 'E03E04_RECIPE_TIER_BLOCK_COUNT_MISMATCH'],
        ['full tier below 120', { seed: 'ok', blockCount: 60, tier: 'full' }, 'E03E04_RECIPE_TIER_BLOCK_COUNT_MISMATCH'],
    ];
    const refusals = [];
    for (const [label, recipe, expectedCode] of cases) {
        let thrown = null;
        try {
            buildProfile(recipe);
        } catch (error) {
            thrown = error;
        }
        assert(thrown !== null, `${label} was refused rather than silently degraded`);
        assert(thrown instanceof RecipeError, `${label} threw a RecipeError`);
        assertEqual(thrown.name, 'RecipeError', `${label} error name`);
        assertEqual(thrown.code, expectedCode, `${label} error code`);
        assert(thrown.message.includes(expectedCode), `${label} message names its code`);
        assert(typeof thrown.field === 'string' && thrown.field.length > 0, `${label} error names the offending field`);
        assert(thrown.stack !== undefined, `${label} is a real Error with a stack`);
        refusals.push(`${label} -> ${thrown.code}`);
    }
    // buildBooks/buildSettingsPatch refuse too: a consumer cannot bypass recipe validation through them.
    let booksRefusal = null;
    try { buildBooks({ seed: '' }); } catch (error) { booksRefusal = error; }
    assert(booksRefusal instanceof RecipeError && booksRefusal.code === 'E03E04_RECIPE_SEED_MISSING', 'buildBooks refuses an empty seed by name');
    console.log('    malformed-recipe refusals:');
    for (const line of refusals) console.log(`      refused: ${line}`);
    return { refusals, count: cases.length + 1 };
});

// ---------------------------------------------------------------------------------------------------------------
// 9. MALFORMED OR INCONSISTENT DOCUMENTS ARE REFUSED BY expectedOrder / buildSettingsPatch
// ---------------------------------------------------------------------------------------------------------------
check('malformed-documents-refused', () => {
    const preset = generatedPreset();
    const bookSet = buildBooks({ seed: SEED });
    const cases = [];

    const missingOrder = deepClone(preset);
    missingOrder.prompt_order[0].order = missingOrder.prompt_order[0].order.filter(entry => entry.identifier !== 'main');
    cases.push(['prompt_order omits a declaration', () => expectedOrder({ preset: missingOrder, books: bookSet }), 'E03E04_PRESET_ORDER_INCOMPLETE']);

    const duplicate = deepClone(preset);
    duplicate.prompts[3].identifier = 'main';
    cases.push(['duplicate declared identifier', () => expectedOrder({ preset: duplicate, books: bookSet }), 'E03E04_PRESET_DUPLICATE_IDENTIFIER']);

    const unknown = deepClone(preset);
    unknown.prompt_order[0].order[0].identifier = 'not_a_declared_prompt';
    cases.push(['prompt_order references an undeclared prompt', () => expectedOrder({ preset: unknown, books: bookSet }), 'E03E04_PRESET_ORDER_UNKNOWN_IDENTIFIER']);

    cases.push(['books object is missing', () => expectedOrder({ preset, books: {} }), 'E03E04_BOOKS_INVALID']);

    const noEntries = deepClone(bookSet);
    delete noEntries.recursiveGlobal.document.entries;
    cases.push(['a generated book document is missing its entries', () => expectedOrder({ preset, books: noEntries }), 'E03E04_BOOKS_MISSING_BOOK']);

    cases.push(['settings patch seed disagrees with the preset', () => buildSettingsPatch({ preset, books: buildBooks({ seed: 'a-different-seed' }) }), 'E03E04_SETTINGS_SEED_MISMATCH']);

    const flatPreset = { prompts: [], prompt_order: [] };
    cases.push(['a non-kit preset is refused rather than guessed at', () => expectedOrder({ preset: flatPreset, books: bookSet }), 'E03E04_PRESET_PROMPTS_MISSING']);

    const refusals = [];
    for (const [label, invoke, expectedCode] of cases) {
        let thrown = null;
        try { invoke(); } catch (error) { thrown = error; }
        assert(thrown !== null, `${label} was refused`);
        assert(thrown instanceof RecipeError, `${label} threw a RecipeError`);
        assertEqual(thrown.code, expectedCode, `${label} error code`);
        refusals.push(`${label} -> ${thrown.code}`);
    }
    // canonicalJson refuses values JSON.stringify would silently rewrite.
    const nonJsonCases = [
        ['undefined member', () => canonicalJson({ a: undefined })],
        ['NaN member', () => canonicalJson({ a: Number.NaN })],
        ['Infinity member', () => canonicalJson({ a: Number.POSITIVE_INFINITY })],
        ['function member', () => canonicalJson({ a: () => 1 })],
        ['sparse array', () => canonicalJson([1, , 3])], // eslint-disable-line no-sparse-arrays
    ];
    for (const [label, invoke] of nonJsonCases) {
        let thrown = null;
        try { invoke(); } catch (error) { thrown = error; }
        assert(thrown instanceof RecipeError, `canonicalJson refuses ${label}`);
        assertEqual(thrown.code === 'E03E04_CANONICAL_NON_JSON' || thrown.code === 'E03E04_CANONICAL_SPARSE_ARRAY', true, `${label} has a named canonicalisation code (got ${thrown.code})`);
        refusals.push(`canonical-json ${label} -> ${thrown.code}`);
    }
    console.log('    malformed-document refusals:');
    for (const line of refusals) console.log(`      refused: ${line}`);
    return { refusals, count: cases.length + nonJsonCases.length };
});

// ---------------------------------------------------------------------------------------------------------------
// 10. THE THREE-SLOT WORLD BOOK
// ---------------------------------------------------------------------------------------------------------------
check('worldbook-three-slots', () => {
    const bookSet = buildBooks({ seed: SEED });
    const order = expectedOrder({ preset: generatedPreset(), books: bookSet });
    const book = order.worldBooks.threeSlot;
    assertEqual(book.markers.length, 3, 'three-slot book entry count');
    const positions = book.markers.map(marker => marker.position).sort((a, b) => a - b);
    assertEqual(JSON.stringify(positions), JSON.stringify([0, 1, 4]), 'positions are before(0) / after(1) / atDepth(4)');
    assertEqual(book.slots.before.length, 1, 'one before-character entry');
    assertEqual(book.slots.after.length, 1, 'one after-character entry');
    const depthGroup = book.slots.depth[0];
    assertEqual(depthGroup.depth, 2, 'atDepth requested depth');
    assertEqual(depthGroup.role, 1, 'atDepth role is user (so the role is distinguishable from a system block)');
    // Slot order is ascending by the entry's `order` (pinned iterates descending and unshifts).
    const orderValues = book.markers.map(marker => marker.order);
    assertEqual(JSON.stringify([...orderValues].sort((a, b) => a - b)), JSON.stringify(orderValues), 'slot content order is ascending by entry order');
    return { positions, depth: depthGroup.depth, role: depthGroup.role };
});

// ---------------------------------------------------------------------------------------------------------------
// 11. THE CARD-EMBEDDED BOOK: RECURSION + SECONDARY KEYS + THE ABSENCE CONTROL
// ---------------------------------------------------------------------------------------------------------------
check('embedded-book-recursion-and-secondary-keys', () => {
    const bookSet = buildBooks({ seed: SEED });
    const order = expectedOrder({ preset: generatedPreset(), books: bookSet });
    const book = order.worldBooks.cardEmbedded;
    assertEqual(bookSet.cardEmbedded.characterBook.entries.length, 4, 'embedded character_book entry count');
    const selectiveEntry = bookSet.cardEmbedded.characterBook.entries[1];
    assertEqual(selectiveEntry.selective, true, 'entry 1 is selective');
    assertEqual(selectiveEntry.secondary_keys.length, 1, 'entry 1 declares a secondary key');
    assertEqual(selectiveEntry.secondary_keys[0], ACTIVATION_TOKENS.bookBSecondary, 'entry 1 secondary key is the recursion-produced token');
    assertEqual(selectiveEntry.extensions.selectiveLogic, 3, 'entry 1 uses AND_ALL (world_info_logic.AND_ALL)');
    assert(book.markers.some(marker => marker.marker === 'MARKER_WB0001'), 'constant before_char marker is manifest-listed');
    assert(book.slots.after.includes('MARKER_WB0002'), 'the trigger+secondary entry is an after-character marker');
    assert(book.slots.depth.some(group => group.markers.includes('MARKER_WB0003')), 'the recursion-step-2 entry is a depth marker via extensions.position override');
    assert(book.expectedAbsent.includes('MARKER_WB0004'), 'the exclude_recursion entry is declared absent');
    assert(order.absent.some(item => item.marker === 'MARKER_WB0004' && item.reason.includes('exclude_recursion')), 'the absence names its pinned cause');
    // The embedded payload is the `data.character_book` DOCUMENT, not a world file: it has no `entries` object
    // keyed by uid, it has the spec's array. Asserting the shape here stops staging it as a world file.
    assert(Array.isArray(bookSet.cardEmbedded.characterBook.entries), 'the embedded payload keeps the spec array shape');
    assertEqual(bookSet.cardEmbedded.characterBook.name, bookSet.selection.embeddedBookImportName, 'import name is declared for the probe');
    return { entries: bookSet.cardEmbedded.characterBook.entries.length, absent: book.expectedAbsent };
});

// ---------------------------------------------------------------------------------------------------------------
// 12. THE RECURSIVE SECONDARY-KEY CHAIN
// ---------------------------------------------------------------------------------------------------------------
check('recursive-secondary-key-chain', () => {
    const bookSet = buildBooks({ seed: SEED });
    const order = expectedOrder({ preset: generatedPreset(), books: bookSet });
    const book = order.worldBooks.recursiveGlobal;
    const steps = bookSet.activation.chain.filter(link => link.book === book.name).map(link => link.step);
    assert(steps.length >= 4, 'the recursive chain has at least four links (constant + three recursion steps)');
    assert([...new Set(steps)].length >= 4, 'the chain reaches at least recursion step 3');
    // Ascending-order slot expansion: before-class entries sorted by their globally unique order.
    const expectedBefore = ['MARKER_WB0001', 'MARKER_WC0005', 'MARKER_WA0001', 'MARKER_WC0001', 'MARKER_WC0004'];
    assertEqual(JSON.stringify(order.sequence.filter(item => item.kind === 'world-before').map(item => item.marker)), JSON.stringify(expectedBefore), 'before-slot marker order is ascending by order across all three books');
    const expectedAfter = ['MARKER_WA0002', 'MARKER_WC0002', 'MARKER_WB0002'];
    assertEqual(JSON.stringify(order.sequence.filter(item => item.kind === 'world-after').map(item => item.marker)), JSON.stringify(expectedAfter), 'after-slot marker order is ascending by order across all three books');
    assertEqual(JSON.stringify(book.slots.depth.find(group => group.depth === 3 && group.role === 1).markers), JSON.stringify(['MARKER_WC0003']), 'depth(3,user) group carries the chain entry');
    assert(book.expectedAbsent.includes('MARKER_WC0006'), 'the preventRecursion absence control is declared');
    // Trigger token is required for the embedded book's entry 1: the probe must place it in the scanned chat.
    assertEqual(JSON.stringify(bookSet.activation.chatTriggerTokens), JSON.stringify([ACTIVATION_TOKENS.chatTriggerBookB]), 'the chat trigger token is declared for the probe');
    // Determinism notes exist so the probe cannot silently add a probability roll or a timed effect.
    assert(bookSet.activation.determinismNotes.length >= 5, 'determinism notes are recorded');
    return { chainSteps: [...new Set(steps)].sort((a, b) => a - b), before: expectedBefore, after: expectedAfter };
});

// ---------------------------------------------------------------------------------------------------------------
// 13. BOOKS ARE DETERMINISTIC AND THE SEED MATTERS
// ---------------------------------------------------------------------------------------------------------------
check('books-deterministic-seed-sensitive', () => {
    const first = buildBooks({ seed: SEED });
    const second = buildBooks({ seed: SEED });
    assertEqual(canonicalJson(first), canonicalJson(second), 'same-seed books are byte-identical');
    const firstSha = sha256(canonicalJson(first));
    const secondSha = sha256(canonicalJson(second));
    assertEqual(firstSha, secondSha, 'same-seed books have the same sha256');
    const other = buildBooks({ seed: `${SEED}-other` });
    assert(canonicalJson(first) !== canonicalJson(other), 'a different seed changes the books document');
    // The profile's block LAYOUT is structural, not seed-dependent; only the identifiers change. This is the
    // property that lets the fixture's own recorded order remain the comparator's input.
    const presetA = buildPreset({ seed: SEED, blockCount: 12 });
    const presetB = buildPreset({ seed: `${SEED}-other`, blockCount: 12 });
    assertEqual(
        JSON.stringify(presetA.e03e04_profile.blocks.map(block => block.marker)),
        JSON.stringify(presetB.e03e04_profile.blocks.map(block => block.marker)),
        'block markers are structural (same for a different seed)',
    );
    assert(canonicalJson(presetA) !== canonicalJson(presetB), 'a different seed changes the preset identifiers/seed members');
    console.log(`    books sha256 = ${firstSha}`);
    return { booksSha256: firstSha };
});

// ---------------------------------------------------------------------------------------------------------------
// 14. ROLE BOUNDARIES
// ---------------------------------------------------------------------------------------------------------------
check('role-boundaries', () => {
    const preset = generatedPreset();
    const plan = preset.e03e04_profile.blocks;
    const roles = new Set(plan.map(block => block.declaredRole));
    assertEqual(JSON.stringify([...roles].sort()), JSON.stringify(['assistant', 'system', 'user']), 'all three roles occur');
    const runs = preset.e03e04_profile.roleRuns;
    assert(runs.length >= 3, 'role runs are recorded');
    for (const run of runs) assert(run.toBlock >= run.fromBlock, `role run ${run.role} is a valid interval`);
    // Contiguity: the declared role of block i follows the run table.
    for (const block of plan) {
        const run = runs.find(item => block.index >= item.fromBlock && block.index <= item.toBlock);
        assertEqual(run.role, block.declaredRole, `block ${block.index} declared role matches its run`);
    }
    const order = expectedOrder({ preset, books: buildBooks({ seed: SEED }) });
    const sequenceRoles = new Set(order.sequence.filter(item => item.kind === 'preset-block').map(item => item.role));
    for (const role of ['system', 'user', 'assistant']) assert(sequenceRoles.has(role), `the flat sequence carries a ${role} block`);
    return { runs: runs.length, roles: [...roles] };
});

// ---------------------------------------------------------------------------------------------------------------
// 15. SFW / SYNTHETIC-ONLY / ASCII-ONLY
// ---------------------------------------------------------------------------------------------------------------
check('sfw-synthetic-only', () => {
    const built = buildProfile({ seed: SEED, blockCount: 120, tier: 'full' });
    const staged = { preset: built.preset, books: built.books, settings: built.settings };
    const strings = [];
    const walk = (value, path) => {
        if (typeof value === 'string') { strings.push({ path, value }); return; }
        if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
        if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    };
    walk(staged, '$');
    assert(strings.length > 1000, `the staged documents carry ${strings.length} strings to scan`);
    for (const { path, value } of strings) {
        assert(/^[\x20-\x7E\n]*$/.test(value), `${path} is printable ASCII (no encoding trap, AGENTS rules 9/12)`);
        assert(!/https?:|:\/\/|www\./i.test(value), `${path} carries no URL`);
        assert(!value.includes('@'), `${path} carries no @ (no e-mail/handle/platform tag)`);
        assert(!/discord|telegram|qq\.com|weibo/i.test(value), `${path} carries no platform handle/watermark`);
        assert(value.length <= 480, `${path} is not long-form prose (${value.length} chars)`);
    }
    // The pinned default skeleton is the only permitted non-marker prompt content; everything else must be a
    // machine-readable marker line. This is what "no user prose" means mechanically.
    const skeletonContents = new Set(PINNED_DEFAULT_PROMPTS.map(prompt => prompt.content).filter(content => typeof content === 'string' && content.length > 0));
    for (const prompt of built.preset.prompts) {
        if (typeof prompt.content !== 'string' || prompt.content.length === 0) continue;
        if (skeletonContents.has(prompt.content)) continue;
        assert(/^MARKER_P\d{4} ROLE=(SYSTEM|USER|ASSISTANT) STEP=\d+ OF=\d+$/.test(prompt.content), `prompt ${prompt.identifier} content is a machine-readable marker line, not prose`);
    }
    // Every world entry's content is a marker line with only synthetic tokens.
    const worldContents = [
        ...Object.values(built.books.threeSlot.document.entries),
        ...Object.values(built.books.recursiveGlobal.document.entries),
        ...built.books.cardEmbedded.characterBook.entries,
    ].map(entry => entry.content);
    for (const content of worldContents) {
        assert(/^MARKER_W[A-C]\d{4} POS=(BEFORE|AFTER|DEPTH) ORDER=\d+(?: [A-Z_]+=[A-Z0-9_]+)*$/.test(content), `world entry content is a synthetic marker line: ${content}`);
    }
    // Stops and template tokens are synthetic too.
    for (const stop of built.preset.stop_strings) assert(/^E03E04_STOP_[A-D]_[0-9A-F]{6}$/.test(stop), `stop string ${stop} is a synthetic token`);
    assert(/^E03E04_IN_[0-9A-F]{6}$/.test(built.preset.instruct.input_sequence), 'instruct sequence is a synthetic token');
    return { strings: strings.length, prompts: built.preset.prompts.length, worldEntries: worldContents.length };
});

// ---------------------------------------------------------------------------------------------------------------
// 16. THE SETTINGS PATCH PUTS THE NON-PRESET MEMBERS IN THEIR REAL HOMES
// ---------------------------------------------------------------------------------------------------------------
check('settings-patch-shape', () => {
    const preset = generatedPreset();
    const bookSet = buildBooks({ seed: SEED });
    const patch = buildSettingsPatch({ preset, books: bookSet });
    assert(patch.world_info_settings, 'world_info_settings member is present (pinned default tree layout)');
    assert(Array.isArray(patch.world_info_settings.world_info.globalSelect), 'globalSelect is an array under world_info_settings');
    assertEqual(JSON.stringify(patch.world_info_settings.world_info.globalSelect), JSON.stringify(bookSet.selection.globalSelect), 'selection matches the books');
    assert(patch.world_info, 'top-level world_info mirror is present (script.js:8013 fallback)');
    assertEqual(patch.world_info_settings.world_info_recursive, true, 'recursion is enabled');
    assertEqual(patch.world_info_settings.world_info_max_recursion_steps, 10, 'recursion steps are bounded');
    assertEqual(typeof patch.power_user.custom_stopping_strings, 'string', 'custom_stopping_strings is the JSON STRING the frontend parses (F7)');
    assertEqual(JSON.parse(patch.power_user.custom_stopping_strings).length, 4, 'four stop strings are persisted');
    assertEqual(patch.power_user.custom_stopping_strings_macro, false, 'stop macro expansion is off (determinism)');
    assertEqual(patch.power_user.instruct.enabled, false, 'instruct template is declared disabled on the chat path');
    assert(patch.power_user.context.story_string.includes('{{#if system}}'), 'context template carries the pinned story-string template');
    return { globalSelect: bookSet.selection.globalSelect, stops: JSON.parse(patch.power_user.custom_stopping_strings).length };
});

// ---------------------------------------------------------------------------------------------------------------
// 17. THE MANIFEST RECORDS THE SEED AND THE SHA256 OF EVERY GENERATED DOCUMENT
// ---------------------------------------------------------------------------------------------------------------
check('manifest-digests', () => {
    const built = buildProfile({ seed: SEED, blockCount: 120, tier: 'full' });
    const manifest = built.manifest;
    assertEqual(manifest.seed, SEED, 'manifest seed');
    for (const key of ['preset', 'threeSlotBook', 'recursiveGlobalBook', 'cardCharacterBook', 'settingsPatch', 'expectedOrder']) {
        const document = manifest.documents[key];
        assert(document, `manifest records document ${key}`);
        assert(/^[0-9a-f]{64}$/.test(document.sha256), `manifest ${key} sha256 is a hex digest`);
        assert(document.byteLength > 0, `manifest ${key} byteLength is positive`);
        assert(!Object.hasOwn(document, 'bytes'), `manifest ${key} does not embed the document bytes`);
    }
    assertEqual(manifest.documents.preset.sha256, sha256(canonicalJson(built.preset)), 'manifest preset digest matches the document');
    assert(manifest.claim.exceedsCommittedMaxima, 'manifest claim says the profile exceeds the committed maxima');
    assert(manifest.claim.statement.includes('119'), 'manifest claim states the committed preset-b maximum');
    assertEqual(built.preset.e03e04_profile.seed, SEED, 'preset recipe record carries the seed');
    assertEqual(presetProfile(built.preset).blockCount, 120, 'presetProfile reads the recipe record');
    let refused = null;
    try { presetProfile({}); } catch (error) { refused = error; }
    assert(refused instanceof RecipeError && refused.code === 'E03E04_PRESET_NOT_A_PROFILE', 'a document that is not one of this kit\'s presets is refused by name');
    return { documents: Object.keys(manifest.documents).length, presetSha256: manifest.documents.preset.sha256 };
});

// ---------------------------------------------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------------------------------------------
function generatedPreset() {
    return buildPreset({ seed: SEED, blockCount: 120, tier: 'full' });
}

let failures = 0;
const results = [];
for (const { name, fn } of checks) {
    try {
        const detail = fn();
        results.push({ name, ok: true, detail });
        console.log(`PASS ${name}`);
    } catch (error) {
        failures += 1;
        results.push({ name, ok: false, detail: String(error?.message ?? error) });
        console.log(`FAIL ${name}: ${error?.message ?? error}`);
    }
}

const built = profile120;
const blockCounts = {
    blockMarkers: built.preset.e03e04_profile.blocks.length,
    enabledRelative: built.expectedOrder.blocks.enabledRelative.length,
    enabledAbsolute: built.expectedOrder.blocks.enabledAbsolute.length,
    disabledBlocks: built.expectedOrder.blocks.disabled.length,
    triggerExcluded: built.expectedOrder.blocks.triggerExcluded.length,
    absentMarkers: built.expectedOrder.absent.length,
    sequenceMarkers: built.expectedOrder.sequence.length,
    worldMarkers: built.expectedOrder.sequence.filter(item => item.kind.startsWith('world')).length + built.expectedOrder.history.depthEntries.reduce((total, group) => total + group.markers.length, 0) + built.expectedOrder.history.absoluteBlocks.reduce((total, group) => total + group.markers.length, 0),
    totalPrompts: built.preset.prompts.length,
};
console.log('');
console.log(`e03e04-profile-kit selftest -- seed ${SEED}, stress tier ${TIERS.full}`);
console.log(`  preset: ${built.preset.prompts.length} declared prompts (${PINNED_DEFAULT_PROMPTS.length} pinned defaults + ${built.preset.e03e04_profile.blockCount} generated blocks), prompt_order references ${built.preset.prompt_order[0].order.length}`);
console.log(`  manifest: ${JSON.stringify(built.manifest.claim.statement)}`);
console.log(`  manifest documents: ${Object.keys(built.manifest.documents).map(key => `${key}=${built.manifest.documents[key].sha256.slice(0, 16)}`).join(' ')}`);
console.log(`  counts: ${JSON.stringify(blockCounts)}`);
console.log(`  books: ${built.books.threeSlot.name} (3 entries), ${built.books.cardEmbedded.name} (${built.books.cardEmbedded.characterBook.entries.length} entries), ${built.books.recursiveGlobal.name} (${Object.keys(built.books.recursiveGlobal.document.entries).length} entries)`);
console.log(`  checks: ${checks.length - failures}/${checks.length} passed`);
if (failures > 0) {
    console.log(`  RESULT: FAIL (${failures} failing check${failures === 1 ? '' : 's'})`);
    process.exitCode = 1;
} else {
    console.log('  RESULT: PASS');
    process.exitCode = 0;
}
