// THE e03e04 PROFILE: the MISSING, DETERMINISTIC INGREDIENTS for the first combined E03 (complex prompt
// laboratory) + E04 (extension collision laboratory) browser scenario.
//
// WHY THIS FILE EXISTS. The M0 audit (docs/alpha16/ownership-map.json, hypotheses E-H6 and E-H7) measured that
// the committed browser harness has NO 120+ prompt preset and NO nested/recursive world book: the committed
// preset derivations are `tests/browser/fixtures/real/preset-a.json` (105 prompts) and `preset-b.json` (119
// prompts), and the journey corpus carries at most 66 prompt entries. A scenario that claims to exercise a
// 120-block Prompt Manager order or world-info recursion therefore cannot be built from the committed corpus
// today. This module is that missing input, GENERATED rather than recorded.
//
// WHAT THIS FILE IS **NOT**. It is not a recording, not a pinned capture, and it makes NO claim about the
// provider wire. It contains no real user prose (AGENTS.md rule 56): every string is synthetic and SFW, either
// a marker, an inline token, or a byte-for-byte copy of a PINNED DEFAULT (PromptManager.js's
// `chatCompletionDefaultPrompts`, quoted below with line numbers). Nothing here decides what the product
// SHOULD produce; the probe records the body on pinned Node and on GoTavern and the comparator compares those
// bytes (AGENTS.md rule 49: a simulated provider may capture and answer, never define correctness). The
// ordering manifest this file returns is a LOCATOR so a red names a source instead of saying "bodies differ",
// not an expected provider body.
//
// =====================================================================================================================
// THE PINNED FACTS THIS GENERATOR IS BUILT AGAINST. SillyTavern 1.19.0 @ 06bde939fb1e9c4c8d8641d810f0a916b5bce127.
// Read these before changing a field; each one is why the generated document has the shape it has.
//
//   F1  THE OPENAI PRESET FILE IS A FLAT oai_settings SLICE. `public/scripts/openai.js:305-409`
//       (`settingsToUpdate`) is the exact key table a preset file applies: `temperature`, `frequency_penalty`,
//       `presence_penalty`, `top_p`, `top_k`, `top_a`, `min_p`, `repetition_penalty`, `openai_max_context`,
//       `openai_max_tokens`, `stream_openai`, `function_calling`, `show_thoughts`, `reasoning_effort`,
//       `verbosity`, `tool_reasoning_mode`, `seed`, `n`, `prompts`, `prompt_order`, `extensions`, ... The
//       apply loop is `openai.js:5046-5065`: it copies ONLY those keys, so a member outside the table is
//       INERT in this file. That is why `instruct`, `context` and `stop_strings` are carried here as members
//       AND ALSO returned by `buildSettingsPatch()` in their real homes (see F6/F7) with the inertness stated.
//
//   F2  PROMPT ENTRIES AND PROMPT ORDER. `public/scripts/PromptManager.js:80-199` defines a prompt
//       (`identifier`, `name`, `role`, `content`, `system_prompt`, `injection_position`, `injection_depth`,
//       `injection_order`, `injection_trigger`, `marker`, `forbid_overrides`). `:2001-2081` is
//       `chatCompletionDefaultPrompts.prompts` (the twelve defaults copied below verbatim), `:2087-2136` is
//       `promptManagerDefaultPromptOrder`, and `:312-339` sets the global prompt-order strategy with
//       `dummyId: 100000` -- which is why the generated `prompt_order` uses `character_id: 100000`.
//
//   F3  ENABLED FLAGS LIVE IN prompt_order, AND THE ASSEMBLY ORDER IS prompt_order. `PromptManager.js:1516-1541`
//       (`getPromptCollection`) iterates the prompt order and adds only entries whose order entry is enabled
//       (and whose `injection_trigger` matches the generation type, :1549-1555). `openai.js:1240-1257`
//       collects `userRelativePrompts` from that collection and `openai.js:1187-1208` adds each at its own
//       collection index (`chatCompletion.add(collection, index)`), so the relative-prompt message order equals
//       `prompt_order`. `PromptManager.js:445-450, 1667-1668` read the ORDER ENTRY for the toggle state, so the
//       mirrored `prompts[].enabled` this kit writes is documentation, never the authority.
//
//   F4  WORLD-INFO POSITION AND ORDER. `public/scripts/world-info.js:855-864` (`world_info_position`:
//       before 0, after 1, ANTop 2, ANBottom 3, atDepth 4, EMTop 5, EMBottom 6, outlet 7); `:88`
//       `sortFn = (a, b) => b.order - a.order`; `:5203-5263` iterates the activated entries in that
//       DESCENDING order and `unshift`s each into its slot, so the JOINED slot text is ASCENDING by `order`.
//       `:5235-5246` groups atDepth entries by `{depth, role}` and unshifts within a group for the same
//       reason. Every entry this kit emits therefore has a GLOBALLY UNIQUE `order`, which makes the slot
//       sequence total and removes any dependence on sort stability.
//
//   F5  RECURSION IS A LOOP OVER THE ACTIVATED CONTENT. `world-info.js:4766-4777` loops while a scan state
//       remains (bounded by `world_info_max_recursion_steps` when non-zero, :4768-4771); `:5117-5144` adds the
//       content of successful non-`preventRecursion` entries to the recursion buffer and continues when
//       `world_info_recursive` is on; `:4870-4873` skips entries with `excludeRecursion` during a RECURSION
//       pass; `:4875-4897` handles constant activation; `:4924-4984` is the selective/secondary-key logic
//       (`world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 }`, :33-38). The buffer includes
//       the recursion buffer on every non-MIN_ACTIVATIONS pass (`:318-326`), which is what makes a
//       secondary-key chain reachable. This kit's books are built so a first generation activates them by
//       construction: constants, one chat trigger token, and content-carried link tokens.
//
//   F6  THE EMBEDDED CARD BOOK IS A V3 PAYLOAD, NOT A WORLD FILE. `world-info.js:5617-5674`
//       (`convertCharacterBook`) maps `data.character_book.entries[]` (`id`, `keys`, `secondary_keys`, `content`,
//       `constant`, `selective`, `insertion_order`, `enabled`, `position: 'before_char'|'after_char'`,
//       `extensions.*`) onto the world-entry template. `:5691-5753` (`checkEmbeddedWorld`) is the IMPORT path:
//       an embedded book is NOT auto-active; a user imports it and it becomes a world named after the book (or
//       "<name>'s Lorebook") and is bound as the character's world. This kit returns the `data.character_book`
//       PAYLOAD only (the journey kit owns the PNG staging) and states the activation path the probe must drive.
//
//   F7  INSTRUCT / CONTEXT / STOP STRINGS DO NOT LIVE IN THE OPENAI PRESET. They are `power_user` members
//       (`instruct`, `context`, `custom_stopping_strings`). `custom_stopping_strings` is a JSON *string* that
//       `power-user.js:3078-3105` JSON.parses, and `openai.js:2814` sends `getCustomStoppingStrings(4)`. The
//       instruct/context templates are TEXT-COMPLETION side (`instruct`/`context` preset directories); on the
//       chat-completion path they have NO wire effect, so the probe must record them as no-wire-effect rather
//       than inventing a marker for them.
//
//   F8  REASONING/TOOL MEMBERS. `openai.js:239-255` defines `reasoning_effort_types`, `verbosity_levels` and
//       `tool_reasoning_modes`; the preset keys are `reasoning_effort`, `verbosity`, `tool_reasoning_mode`,
//       `function_calling`, `show_thoughts` (all in `settingsToUpdate`). This profile keeps `function_calling`
//       OFF: with tool calling on, `ToolManager` would mix extension state into the body, which is E04's
//       question, not this generator's, and it would make the expected body depend on the installed extension
//       set. The tool/schema members below are declared and inert; the probe records exactly what reaches the
//       wire.
// =====================================================================================================================
//
// DETERMINISM AND CANONICALISATION (the rule the selftest demonstrates):
//   * Every generated value is a pure function of the VALIDATED recipe `{ seed, blockCount [, tier] }`: there is
//     no `Date`, no `Math.random`, no `process.env`, no locale comparison, no filesystem, and no network access
//     anywhere in this module. Iteration is over declared arrays and `for` integer loops only.
//   * Object members are built in a fixed literal order, and `canonicalJson()` independently sorts every
//     object's own enumerable keys by UTF-16 code unit and preserves array order. Two builds therefore agree
//     both as `JSON.stringify(document)` and as canonical bytes, and `sha256(canonicalJson(document))` does not
//     depend on insertion order. Non-JSON values (undefined, functions, symbols, bigint, non-finite numbers,
//     sparse arrays) are REFUSED with a named error instead of being silently degraded by `JSON.stringify`.
//   * Numbers are integer literals or short decimal literals; no floating-point arithmetic is performed, so no
//     rounding decision can differ between runs or engines. `seed` (the sampling seed) is a deterministic
//     32-bit integer derived from the recipe seed, never `-1`.
//   * Prompt identifiers are deterministic UUID-v4-SHAPED strings derived from `sha256(seed|kind|index)` (the
//     version/variant nibbles are set), so a re-run of the same recipe produces the same document byte for byte
//     while still being shaped like the identifiers the frontend itself generates (`PromptManager.js:622`
//     `getUuidv4()`), and they are unique by construction.
//
// =====================================================================================================================
// WIRING PLAN FOR THE NEXT STEP (this file deliberately touches no existing file; the probe, kits and
// comparator named here are consumed by the NEXT lane, not edited by this task):
//
//   1. THE PROBE. `tests/browser/combination-journey-probe.mjs` gains a `--profile e03e04` mode (design sections 3/4).
//      Its staging step, BEFORE the server boots, consumes this module:
//        - `buildProfile({ seed, blockCount, tier })` -> one object holding every ingredient + the digests;
//        - write `profile.preset` as `data/default-user/OpenAI Settings/e03e04-profile.json` (F1), merged with
//          `profile.settings` (world-info selection + recursion + power_user stops/instruct/context) through the
//          probe's existing settings writer;
//        - write `profile.books.threeSlot.document` and `profile.books.recursiveGlobal.document` as
//          `data/default-user/worlds/<name>.json` (same staging the proven `worldinfo-slots-kit.mjs`
//          `stageWorldBook` uses);
//        - hand `profile.books.cardEmbedded.characterBook` to
//          `tests/browser/extensions/combination-journey-kit.mjs`, which owns PNG staging (`imageChunksOnly`,
//          `tEXt` chunks) and writes the card with `data.character_book` embedded (F6). Neither this module nor
//          that kit may drive the import itself: the PROBE must reach the product's own path
//          (`checkEmbeddedWorld`, F6) or record `card-character-book-marker` as unproven. It must not silently
//          stage a converted copy and call the embedded path proven.
//        - put the recipe's trigger tokens (`profile.books.activation.chatTriggerTokens`) in the first user
//          message, and select the preset through the frontend's own control (never by name, per
//          preset-kit's auto-select hazard).
//      The probe records `profile.expectedOrder` beside the captured leg record; it does NOT assert on it in the
//      probe.
//   2. THE KIT. `tests/browser/extensions/combination-journey-kit.mjs` remains the PNG/card/regex/marker-constant
//      owner. This module only supplies `characterBook` for `data.character_book` and the profile documents.
//   3. THE COMPARATOR. `tests/browser/compare-combination-journey.mjs` reads `expectedOrder` and asserts, on the
//      RECORDED body of each leg:
//        - `preset-block-present-<MARKER_Pxxxx>`: every enabled Relative block marker occurs exactly once, in the
//          `sequence` order (this is design section 5.4; the fixture's OWN body is the expectation, not this file's);
//        - `preset-block-absent-<MARKER_Pxxxx>`: every `absent` marker occurs ZERO times;
//        - `preset-block-order`: the observed marker indexes are strictly increasing in `sequence` order;
//        - `worldbook-order`: the observed world markers are strictly increasing in slot order, and each slot's
//          entries are ascending by `order` (F4);
//        - `worldbook-depth-<depth>-<role>`: depth-group markers sit at the expected distance from the end (the
//          measured offset is the pinned leg's, following the pattern already established by
//          `worldinfo-slots-kit.mjs`'s `PINNED_DEPTH_OFFSET`; this module records the REQUESTED depth only and
//          claims no offset);
//        - `card-character-book-marker`: the embedded book's markers are present, which is the only evidence the
//          import path ran;
//        - role boundaries: the observed role of each block marker equals the `role` in `sequence`.
//   4. NEGATIVE CONTROLS (each must turn a NAMED assertion red before the scenario is wired into CI; design section 6):
//        - swap two entries of `prompt_order` -> `preset-block-order`;
//        - flip one declared-disabled block to enabled (or drop an enabled one from the order) ->
//          `preset-block-absent-<MARKER>` / `preset-block-present-<MARKER>`;
//        - swap two world entries' `order` (or re-run with `expectedOrder` computed after the swap) ->
//          `worldbook-order`;
//        - omit the card-embedded payload -> `card-character-book-marker`;
//        - make both subjects produce identical captures with every knob off -> `HARNESS NON-DISCRIMINATING`
//          (AGENTS.md rule 50), because the recipe's own documents differ when its inputs differ.
//   5. REFUSALS ARE PART OF THE CONTRACT. A malformed recipe (`buildPreset`) or an inconsistent preset/scripts
//      document (`expectedOrder`) throws a named `RecipeError` with a stable `code`; the comparator/probe must
//      let that refuse the run rather than run with a silently smaller profile ("an assertion that cannot fail
//      is decoration", AGENTS.md rule 7).
//
// AGENTS.md rules this file is written against: 8 (a preset must change the final context, fields/order/roles/
// depths/stops/samplers/reasoning), 9 (synthetic SFW, ASCII-only bytes), 48 (two halves: Node(X) == Go(X) AND
// X != Y inside one implementation -- the disabled/trigger-excluded/absent markers are the second half), 49 (a
// simulated provider never defines correctness), 50 (a non-discriminating harness fails itself), 56 (no user
// artifact: every string is synthetic or a pinned default). It is importable: named exports only, no top-level
// side effects, no CLI parsing, no I/O.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------------------------------------------
// IDENTITY AND LIMITS
// ---------------------------------------------------------------------------------------------------------------

export const PINNED_BASELINE = 'SillyTavern 1.19.0 @ 06bde939fb1e9c4c8d8641d810f0a916b5bce127';
export const PROFILE_KIND = 'e03e04-profile';
export const PROFILE_SCHEMA_VERSION = 1;

/** The design's stress tiers (docs/alpha16/first-scenario-design.md section 7). */
export const TIERS = Object.freeze({ fast: 12, medium: 60, full: 120 });

/** A hard ceiling so a typo cannot allocate an unbounded document; it is a REFUSAL bound, not a tier. */
export const MAX_BLOCKS = 512;

/** The pinned `promptOrder.dummyId` (`PromptManager.js:336`): the character id used by the global strategy. */
export const PROMPT_ORDER_DUMMY_ID = 100000;

// The COMMITTED MAXIMA this generator exists to exceed, measured by M0 from the tree (NOT copied from prose):
// `tests/browser/fixtures/real/preset-a.json` has 105 prompts, `preset-b.json` has 119, and the journey corpus
// is <= 66. These are stated so the selftest's "120+" claim is a comparison against measured committed data.
export const COMMITTED_MAXIMA = Object.freeze({
    presetA: Object.freeze({ file: 'tests/browser/fixtures/real/preset-a.json', prompts: 105 }),
    presetB: Object.freeze({ file: 'tests/browser/fixtures/real/preset-b.json', prompts: 119 }),
    journeyCorpus: Object.freeze({ source: 'tests/browser/fixtures/real/* journey corpus', maxPrompts: 66 }),
});

/** The pinned default prompt skeleton, verbatim from `PromptManager.js:2001-2081` (a pinned DEFAULT, not prose). */
export const PINNED_DEFAULT_PROMPTS = Object.freeze([
    Object.freeze({ name: 'Main Prompt', system_prompt: true, role: 'system', content: "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.", identifier: 'main' }),
    Object.freeze({ name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '', identifier: 'nsfw' }),
    Object.freeze({ identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true }),
    Object.freeze({ name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '', identifier: 'jailbreak' }),
    Object.freeze({ identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true }),
    Object.freeze({ identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true }),
    Object.freeze({ identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true }),
    Object.freeze({ identifier: 'enhanceDefinitions', role: 'system', name: 'Enhance Definitions', content: "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.", system_prompt: true, marker: false }),
    Object.freeze({ identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true }),
    Object.freeze({ identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true }),
    Object.freeze({ identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true }),
    Object.freeze({ identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true }),
]);

/** `PromptManager.js:2087-2136` (`promptManagerDefaultPromptOrder`), kept as a source-cited reference. */
export const PINNED_DEFAULT_PROMPT_ORDER = Object.freeze([
    'main', 'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario',
    'enhanceDefinitions', 'nsfw', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'jailbreak',
]);

// Block/entry markers. The patterns are exported so the comparator can classify a marker from its text alone.
export const BLOCK_MARKER_PATTERN = /^MARKER_P\d{4}$/;
export const WORLD_MARKER_PATTERN = /^MARKER_W[A-C]\d{4}$/;
export const MARKER_PATTERN = /^MARKER_(P\d{4}|W[A-C]\d{4})$/;
// Unanchored finders: an entry's content CARRIES its marker inside a synthetic marker line.
export const BLOCK_MARKER_FIND = /MARKER_P\d{4}/;
export const WORLD_MARKER_FIND = /MARKER_W[A-C]\d{4}/;

/** Block marker: one per declared block, unique and attributable (`design` section 4.1). */
export function blockMarker(index) {
    if (!Number.isInteger(index) || index < 1 || index > 9999) throw new RecipeError('E03E04_MARKER_INDEX_RANGE', 'index', `block marker index must be an integer in 1..9999, got ${String(index)}`);
    return `MARKER_P${String(index).padStart(4, '0')}`;
}

/** World-entry marker: book code plus uid, unique and attributable. */
export function worldMarker(bookCode, uid) {
    if (!/^[A-C]$/.test(String(bookCode))) throw new RecipeError('E03E04_MARKER_BOOK_CODE', 'bookCode', `book code must be A, B or C, got ${String(bookCode)}`);
    if (!Number.isInteger(uid) || uid < 0 || uid > 9999) throw new RecipeError('E03E04_MARKER_INDEX_RANGE', 'uid', `entry uid must be an integer in 0..9999, got ${String(uid)}`);
    return `MARKER_W${bookCode}${String(uid).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// NAMED REFUSALS
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every refusal in this module is one of these, with a stable `code` and the offending `field`. The point is that
 * a malformed recipe stops the run with a name instead of producing a smaller profile that a green could hide
 * (AGENTS.md rule 7). `RecipeError` is the only error this module throws deliberately.
 */
export class RecipeError extends Error {
    constructor(code, field, message) {
        super(`${code} (${field}): ${message}`);
        this.name = 'RecipeError';
        this.code = code;
        this.field = field;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// CANONICAL JSON AND DIGESTS
// ---------------------------------------------------------------------------------------------------------------

const utf8 = value => Buffer.from(String(value), 'utf8');

function assertJsonValue(value, path) {
    if (value === null) return;
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return;
    if (type === 'number') {
        // JSON.stringify(nulls) NaN/Infinity into "null": silently degrading a digest input is exactly what this
        // module may not do, so the value is refused instead.
        if (!Number.isFinite(value)) throw new RecipeError('E03E04_CANONICAL_NON_JSON', path, `non-finite number ${String(value)} cannot be canonicalised`);
        return;
    }
    if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
        throw new RecipeError('E03E04_CANONICAL_NON_JSON', path, `${type} cannot be canonicalised (JSON.stringify would silently drop or rewrite it)`);
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) throw new RecipeError('E03E04_CANONICAL_SPARSE_ARRAY', `${path}[${index}]`, 'sparse arrays cannot be canonicalised');
            assertJsonValue(value[index], `${path}[${index}]`);
        }
        return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new RecipeError('E03E04_CANONICAL_NON_JSON', path, 'only plain objects, arrays and JSON scalars can be canonicalised');
    }
    for (const key of Object.keys(value)) assertJsonValue(value[key], `${path}.${key}`);
}

const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function normaliseJson(value) {
    if (Array.isArray(value)) return value.map(normaliseJson);
    if (value && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort(compareCodeUnits)) sorted[key] = normaliseJson(value[key]);
        return sorted;
    }
    return value;
}

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, arrays in declared order. This is the digest and
 * byte form; it refuses non-JSON values rather than letting `JSON.stringify` degrade them.
 */
export function canonicalJson(value, space = 0) {
    assertJsonValue(value, '$');
    return JSON.stringify(normaliseJson(value), null, space);
}

/** The canonical bytes a staged document must have on disk (canonical JSON plus one trailing newline, UTF-8). */
export function documentBytes(value) {
    return `${canonicalJson(value, 2)}\n`;
}

/**
 * SHA-256 helper. A string hashes as UTF-8 text; a Buffer/TypedArray hashes as its bytes; any other JSON value
 * hashes as canonical JSON. The algorithm and the input bytes are the caller's evidence, so this returns the
 * lowercase hex digest only.
 */
export function sha256(value) {
    let bytes;
    if (typeof value === 'string') bytes = utf8(value);
    else if (Buffer.isBuffer(value)) bytes = value;
    else if (value instanceof Uint8Array) bytes = Buffer.from(value);
    else bytes = utf8(canonicalJson(value));
    return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------
// DETERMINISTIC DERIVATIONS (no clock, no RNG, no environment)
// ---------------------------------------------------------------------------------------------------------------

function digestNibbles(seed, kind, index) {
    return sha256(`${String(seed)}|${kind}|${String(index)}`);
}

/** A deterministic UUID-v4-SHAPED identifier (version/variant nibbles set, rest from sha256). */
function deterministicUuid(seed, kind, index) {
    const hex = digestNibbles(seed, kind, index);
    const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A deterministic 32-bit sampling seed: never -1 (which would ask the provider to choose). */
function deterministicSamplingSeed(seed) {
    return Number.parseInt(sha256(`${String(seed)}|sampling-seed`).slice(0, 7), 16) + 1;
}

const SEED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Validate a seed value in isolation; used by both `buildPreset` and `buildBooks`. */
function validateSeed(seed, field = 'seed') {
    if (seed === undefined) throw new RecipeError('E03E04_RECIPE_SEED_MISSING', field, 'a seed string is required');
    if (typeof seed !== 'string') throw new RecipeError('E03E04_RECIPE_SEED_TYPE', field, `seed must be a string, got ${typeof seed}`);
    if (seed.length === 0) throw new RecipeError('E03E04_RECIPE_SEED_MISSING', field, 'seed must not be empty');
    // ASCII-only, so a generated file can never carry an encoding trap (AGENTS.md rules 9/12) and so the seed
    // is representable in every staging path.
    if (!SEED_PATTERN.test(seed)) throw new RecipeError('E03E04_RECIPE_SEED_CHARSET', field, `seed must match ${SEED_PATTERN} (ASCII letters, digits, dot, underscore, colon, hyphen; max 64)`);
    return seed;
}

/**
 * Validate and NORMALISE a recipe. Nothing is clamped, defaulted or repaired: an unknown field, a bad seed, a
 * non-integer block count, an out-of-range block count or a tier/count disagreement is refused by name.
 */
export function validateRecipe(recipe) {
    if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) {
        throw new RecipeError('E03E04_RECIPE_NOT_AN_OBJECT', 'recipe', `recipe must be an object with { seed, blockCount, tier? }, got ${Array.isArray(recipe) ? 'array' : typeof recipe}`);
    }
    const allowed = new Set(['seed', 'blockCount', 'tier']);
    for (const key of Object.keys(recipe)) {
        if (!allowed.has(key)) throw new RecipeError('E03E04_RECIPE_UNKNOWN_FIELD', key, `unknown recipe field; allowed fields are ${[...allowed].join(', ')}`);
    }
    const seed = validateSeed(recipe.seed);
    if (recipe.blockCount === undefined) throw new RecipeError('E03E04_RECIPE_BLOCK_COUNT_MISSING', 'blockCount', 'blockCount is required');
    if (!Number.isInteger(recipe.blockCount)) throw new RecipeError('E03E04_RECIPE_BLOCK_COUNT_TYPE', 'blockCount', `blockCount must be an integer, got ${typeof recipe.blockCount}`);
    if (recipe.blockCount < 1 || recipe.blockCount > MAX_BLOCKS) throw new RecipeError('E03E04_RECIPE_BLOCK_COUNT_RANGE', 'blockCount', `blockCount must be in 1..${MAX_BLOCKS}, got ${recipe.blockCount}`);
    let tier = null;
    if (recipe.tier !== undefined) {
        if (typeof recipe.tier !== 'string' || !Object.hasOwn(TIERS, recipe.tier)) {
            throw new RecipeError('E03E04_RECIPE_TIER_UNKNOWN', 'tier', `tier must be one of ${Object.keys(TIERS).join(', ')}, got ${JSON.stringify(recipe.tier)}`);
        }
        tier = recipe.tier;
        const expected = TIERS[tier];
        // fast/medium are exact tier sizes. full is the stress tier and accepts 120+ so the "120+" claim is a
        // real bound, not an equality that a 119-block profile could satisfy.
        const satisfied = tier === 'full' ? recipe.blockCount >= TIERS.full : recipe.blockCount === expected;
        if (!satisfied) throw new RecipeError('E03E04_RECIPE_TIER_BLOCK_COUNT_MISMATCH', 'tier', `tier ${tier} requires blockCount ${tier === 'full' ? '>=' : '==='} ${expected}, got ${recipe.blockCount}`);
    }
    return { seed, blockCount: recipe.blockCount, tier };
}

// ---------------------------------------------------------------------------------------------------------------
// PRESET GENERATION
// ---------------------------------------------------------------------------------------------------------------

const ROLE_CYCLE = Object.freeze(['system', 'user', 'assistant']);
const ROLE_RUN = 4;          // blocks 1-4 system, 5-8 user, 9-12 assistant, 13-16 system, ...
const ABSOLUTE_EVERY = 11;   // every 11th block is an ABSOLUTE (in-chat) prompt instead of a relative one
const TRIGGER_EXCLUDED_EVERY = 47; // every 47th block carries injection_trigger ['continue']
const TRIGGER_EXCLUDED_OFFSET = 7;
const ENABLED_MODULUS = 3;   // blocks where index % 3 === 0 are disabled in the order

/** Block role, deterministic in runs of four: the role BOUNDARY the scenario needs (system/user/assistant). */
function roleForBlock(index) {
    return ROLE_CYCLE[Math.floor((index - 1) / ROLE_RUN) % ROLE_CYCLE.length];
}

function isDisabledBlock(index) {
    return index % ENABLED_MODULUS === 0;
}

function isAbsoluteBlock(index) {
    return index % ABSOLUTE_EVERY === 0;
}

/** Enabled but excluded from a `normal` generation by injection_trigger (PromptManager.js:1549-1555). */
function isTriggerExcludedBlock(index) {
    return !isDisabledBlock(index) && index % TRIGGER_EXCLUDED_EVERY === TRIGGER_EXCLUDED_OFFSET;
}

function blockContent(index, blockCount, role) {
    // Deliberately a machine-readable one-liner: no prose, no names, no URLs, no user data. The marker is the
    // presence evidence; ROLE and STEP are the attribution evidence for role boundaries and order.
    return `MARKER_P${String(index).padStart(4, '0')} ROLE=${role.toUpperCase()} STEP=${index} OF=${blockCount}`;
}

function buildInstructTemplate(seed) {
    // Shape: a PINNED INSTRUCT PRESET FILE (`default/content/presets/instruct/Adventure.json` field set). All
    // sequences are synthetic tokens, never user text. These members are TEXT-COMPLETION side (F7): they have no
    // wire effect on the chat-completion path, which the expected-order manifest records as no-wire-effect.
    return {
        input_sequence: `E03E04_IN_${seedToken(seed)}`,
        output_sequence: `E03E04_OUT_${seedToken(seed)}`,
        last_output_sequence: '',
        system_sequence: `E03E04_SYS_${seedToken(seed)}`,
        stop_sequence: `E03E04_STOP_${seedToken(seed)}`,
        wrap: true,
        macro: false,
        names_behavior: 'none',
        activation_regex: '',
        first_output_sequence: '',
        skip_examples: false,
        output_suffix: ' ',
        input_suffix: ' ',
        system_suffix: ' ',
        user_alignment_message: '',
        system_same_as_user: false,
        last_system_sequence: '',
        first_input_sequence: '',
        last_input_sequence: '',
        sequences_as_stop_strings: false,
        story_string_prefix: '',
        story_string_suffix: '',
        name: 'e03e04-instruct',
    };
}

function buildContextTemplate(seed) {
    // Shape: a PINNED CONTEXT PRESET FILE (`default/content/presets/context/Default.json` field set). The story
    // string is the pinned default template with a synthetic tail token so a context template that DID reach the
    // body would be attributable; on the chat-completion path it does not (F7).
    return {
        story_string: "{{#if system}}{{system}}\n{{/if}}{{#if wiBefore}}{{wiBefore}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{personality}}\n{{/if}}{{#if scenario}}{{scenario}}\n{{/if}}{{#if wiAfter}}{{wiAfter}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}{{trim}}",
        example_separator: `E03E04_CTX_${seedToken(seed)}`,
        chat_start: '',
        use_stop_strings: false,
        names_as_stop_strings: false,
        story_string_position: 0,
        story_string_depth: 1,
        story_string_role: 0,
        always_force_name2: false,
        trim_sentences: false,
        single_line: false,
        name: 'e03e04-context',
    };
}

function seedToken(seed) {
    return sha256(`${seed}|token`).slice(0, 6).toUpperCase();
}

function buildStopStrings(seed) {
    // `openai.js:144` caps the request at `openai_max_stop_strings = 4`; four synthetic stops exercise the cap.
    const token = seedToken(seed);
    return [`E03E04_STOP_A_${token}`, `E03E04_STOP_B_${token}`, `E03E04_STOP_C_${token}`, `E03E04_STOP_D_${token}`];
}

/** The declared block metadata, regenerated from the same rules `buildPreset` uses (kept in one place). */
function blockPlan(recipe) {
    const plan = [];
    for (let index = 1; index <= recipe.blockCount; index += 1) {
        const role = roleForBlock(index);
        const absolute = isAbsoluteBlock(index);
        plan.push({
            index,
            marker: blockMarker(index),
            identifier: deterministicUuid(recipe.seed, 'block', index),
            name: `E03E04_BLOCK_P${String(index).padStart(4, '0')}`,
            role: absolute ? 'system' : role,
            declaredRole: role,
            disabled: isDisabledBlock(index),
            triggerExcluded: isTriggerExcludedBlock(index),
            absolute,
            injectionPosition: absolute ? 1 : 0,
            injectionDepth: absolute ? 1 + (Math.floor(index / ABSOLUTE_EVERY) - 1) % 3 : 4,
            injectionOrder: absolute ? 100 + index : 100,
            injectionTrigger: isTriggerExcludedBlock(index) ? ['continue'] : [],
        });
    }
    return plan;
}

function buildPromptOrder(plan) {
    const half = Math.ceil(plan.length / 2);
    const firstRun = plan.slice(0, half);
    const secondRun = plan.slice(half);
    const entry = block => ({ identifier: block.identifier, enabled: !block.disabled });
    return [
        { identifier: 'main', enabled: true },
        { identifier: 'worldInfoBefore', enabled: true },
        ...firstRun.map(entry),
        { identifier: 'personaDescription', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'charPersonality', enabled: true },
        { identifier: 'scenario', enabled: true },
        { identifier: 'enhanceDefinitions', enabled: false },
        { identifier: 'nsfw', enabled: true },
        { identifier: 'worldInfoAfter', enabled: true },
        { identifier: 'dialogueExamples', enabled: true },
        ...secondRun.map(entry),
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
    ];
}

/**
 * BUILD THE PRESET. `buildPreset({ seed, blockCount, tier? })` returns one flat preset document (the shape a
 * preset file has, F1) whose `prompts` are the twelve pinned defaults plus `blockCount` generated marker blocks
 * and whose `prompt_order` references every declared prompt exactly once.
 *
 * The generated block rules, deterministic in `index`:
 *   - role runs of four: blocks 1-4 system, 5-8 user, 9-12 assistant, repeating (F2 role boundaries);
 *   - disabled: `index % 3 === 0` (mixed enabled/disabled, the design's section 5.4 control);
 *   - trigger-excluded: enabled blocks where `index % 47 === 7` carry `injection_trigger: ['continue']`, so they
 *     are absent from a `normal` generation even though the order says enabled (F3; a deliberate exclusion);
 *   - absolute: `index % 11 === 0` are `injection_position: 1` with a deterministic `injection_depth` in 1..3 and
 *     a unique `injection_order` (F2; these are in-chat injections, not relative messages).
 *
 * Members `instruct`, `context`, `stop_strings` and `e03e04_profile` are carried in this document for one-call
 * convenience. They are INERT in the preset file (F1: `settingsToUpdate` has no such keys); their real homes are
 * returned by `buildSettingsPatch()`, and the header states this rather than implying they reach the wire.
 */
export function buildPreset(recipeInput) {
    const recipe = validateRecipe(recipeInput);
    const plan = blockPlan(recipe);
    const order = buildPromptOrder(plan);
    const stopStrings = buildStopStrings(recipe.seed);

    const prompts = [];
    for (const prompt of PINNED_DEFAULT_PROMPTS) prompts.push({ ...prompt });
    for (const block of plan) {
        prompts.push({
            identifier: block.identifier,
            name: block.name,
            // Mirrored for readability only; `prompt_order` is the authority (F3, PromptManager.js:1667-1668).
            enabled: !block.disabled,
            system_prompt: false,
            role: block.role,
            content: blockContent(block.index, recipe.blockCount, block.role),
            injection_position: block.injectionPosition,
            injection_depth: block.injectionDepth,
            injection_order: block.injectionOrder,
            injection_trigger: block.injectionTrigger,
            forbid_overrides: false,
            marker: false,
        });
    }

    const document = {
        // Sampler members, preset-side names from `settingsToUpdate` (F1). No arithmetic is performed on them.
        temperature: 1.37,
        frequency_penalty: 0.23,
        presence_penalty: 0.29,
        top_p: 0.91,
        top_k: 41,
        top_a: 0.13,
        min_p: 0.07,
        repetition_penalty: 1.11,
        // Token-limit boundary members. Kept generous so 132 markers plus history fit without a budget truncation
        // (a truncation would make the presence assertions nondeterministic), while still being a bounded context.
        openai_max_context: 16384,
        openai_max_tokens: 1024,
        max_context_unlocked: true,
        // Generation identity members.
        seed: deterministicSamplingSeed(recipe.seed),
        n: 1,
        stream_openai: true,
        // Reasoning / tool members (F8). Tool CALLING is off by design: with it on, extension-provided tools would
        // enter the body and make the expected body depend on the installed extension set (E04's question).
        reasoning_effort: 'high',
        verbosity: 'low',
        tool_reasoning_mode: 'since_last_user',
        function_calling: false,
        show_thoughts: true,
        enable_web_search: false,
        request_images: false,
        // Prompt-manager members.
        prompts,
        prompt_order: [{ character_id: PROMPT_ORDER_DUMMY_ID, order }],
        // Unknown-extension subtree: an AGENTS.md rule 11 preservation canary (a pinned save must not drop it).
        // It is synthetic and never a feature; nothing reads it on the assembly path.
        extensions: {
            e03e04_profile: {
                kind: PROFILE_KIND,
                schemaVersion: PROFILE_SCHEMA_VERSION,
                seed: recipe.seed,
                blockCount: recipe.blockCount,
                tier: recipe.tier,
                note: 'synthetic unknown-extension subtree; preservation canary only',
                tool_schema: { name: 'e03e04_schema', version: 1, fields: ['marker', 'role', 'step'] },
            },
        },
        // Bundle-carried, INERT in the preset file (F1). Real homes: `buildSettingsPatch()` (F7).
        instruct: buildInstructTemplate(recipe.seed),
        context: buildContextTemplate(recipe.seed),
        stop_strings: stopStrings,
        // Machine-readable recipe record so a consumer does not have to re-derive the rules.
        e03e04_profile: {
            kind: PROFILE_KIND,
            schemaVersion: PROFILE_SCHEMA_VERSION,
            seed: recipe.seed,
            blockCount: recipe.blockCount,
            tier: recipe.tier,
            skeletonPromptCount: PINNED_DEFAULT_PROMPTS.length,
            totalPromptCount: PINNED_DEFAULT_PROMPTS.length + recipe.blockCount,
            blocks: plan.map(block => ({
                index: block.index,
                marker: block.marker,
                identifier: block.identifier,
                role: block.role,
                declaredRole: block.declaredRole,
                disabled: block.disabled,
                triggerExcluded: block.triggerExcluded,
                absolute: block.absolute,
                injectionDepth: block.injectionDepth,
                injectionOrder: block.injectionOrder,
            })),
            roleRuns: (() => {
                const runs = [];
                for (const block of plan) {
                    const last = runs[runs.length - 1];
                    if (last && last.role === block.declaredRole && last.toBlock === block.index - 1) last.toBlock = block.index;
                    else runs.push({ role: block.declaredRole, fromBlock: block.index, toBlock: block.index });
                }
                return runs;
            })(),
            customSamplers: { temperature: 1.37, top_p: 0.91, top_k: 41, top_a: 0.13, min_p: 0.07, repetition_penalty: 1.11, frequency_penalty: 0.23, presence_penalty: 0.29 },
            reasoningToolSchema: { reasoning_effort: 'high', verbosity: 'low', tool_reasoning_mode: 'since_last_user', function_calling: false, show_thoughts: true },
            stopStrings,
            wireEffect: {
                relativeBlocks: 'provider messages in prompt_order order (F3)',
                absoluteBlocks: 'in-chat injections at injection_depth, grouped/ordered by injection_order descending (openai.js:819-871)',
                instructTemplate: 'no-wire-effect: text-completion side only (F7)',
                contextTemplate: 'no-wire-effect: text-completion side only (F7)',
                stopStrings: 'wire effect comes from power_user.custom_stopping_strings via buildSettingsPatch (F7)',
            },
        },
    };
    assertPresetDocument(document);
    return document;
}

/**
 * Fetch the preset's own recipe record (the `e03e04_profile` member). Refuses a document that is not one this
 * module generated, so a consumer cannot silently point `expectedOrder` at an unrelated preset.
 */
export function presetProfile(preset) {
    const record = preset?.e03e04_profile;
    if (!record || record.kind !== PROFILE_KIND || record.schemaVersion !== PROFILE_SCHEMA_VERSION) {
        throw new RecipeError('E03E04_PRESET_NOT_A_PROFILE', 'preset.e03e04_profile', 'the preset is not a document generated by e03e04-profile-kit.mjs');
    }
    return record;
}

function assertPresetDocument(preset) {
    if (preset === null || typeof preset !== 'object' || Array.isArray(preset)) throw new RecipeError('E03E04_PRESET_NOT_AN_OBJECT', 'preset', 'preset must be an object');
    if (!Array.isArray(preset.prompts) || preset.prompts.length === 0) throw new RecipeError('E03E04_PRESET_PROMPTS_MISSING', 'preset.prompts', 'preset.prompts must be a non-empty array');
    if (!Array.isArray(preset.prompt_order) || preset.prompt_order.length !== 1) throw new RecipeError('E03E04_PRESET_ORDER_MISSING', 'preset.prompt_order', 'preset.prompt_order must be a single { character_id, order } entry');
    const order = preset.prompt_order[0]?.order;
    if (!Array.isArray(order) || order.length === 0) throw new RecipeError('E03E04_PRESET_ORDER_MISSING', 'preset.prompt_order[0].order', 'prompt_order[0].order must be a non-empty array');
    const declared = new Set();
    for (const prompt of preset.prompts) {
        if (!prompt || typeof prompt.identifier !== 'string' || prompt.identifier.length === 0) throw new RecipeError('E03E04_PRESET_PROMPT_IDENTIFIER_MISSING', 'preset.prompts[]', 'every declared prompt needs a non-empty string identifier');
        if (declared.has(prompt.identifier)) throw new RecipeError('E03E04_PRESET_DUPLICATE_IDENTIFIER', `preset.prompts.${prompt.identifier}`, 'two declared prompts share an identifier');
        declared.add(prompt.identifier);
    }
    const referenced = new Set();
    for (const entry of order) {
        if (!entry || typeof entry.identifier !== 'string') throw new RecipeError('E03E04_PRESET_ORDER_ENTRY_INVALID', 'preset.prompt_order[0].order[]', 'every order entry needs a string identifier');
        if (!declared.has(entry.identifier)) throw new RecipeError('E03E04_PRESET_ORDER_UNKNOWN_IDENTIFIER', `preset.prompt_order.${entry.identifier}`, 'prompt_order references an undeclared prompt');
        if (referenced.has(entry.identifier)) throw new RecipeError('E03E04_PRESET_ORDER_DUPLICATE_IDENTIFIER', `prompt.prompt_order.${entry.identifier}`, 'prompt_order references the same prompt twice');
        if (typeof entry.enabled !== 'boolean') throw new RecipeError('E03E04_PRESET_ORDER_ENTRY_INVALID', `preset.prompt_order.${entry.identifier}.enabled`, 'every order entry needs a boolean enabled flag');
        referenced.add(entry.identifier);
    }
    for (const identifier of declared) {
        if (!referenced.has(identifier)) throw new RecipeError('E03E04_PRESET_ORDER_INCOMPLETE', `preset.prompts.${identifier}`, 'a declared prompt is not referenced by prompt_order');
    }
    // Marker uniqueness/format across the DECLARED block prompts.
    const markers = [];
    for (const prompt of preset.prompts) {
        const match = typeof prompt.content === 'string' ? prompt.content.match(/MARKER_P\d{4}/) : null;
        if (!match) continue;
        if (!BLOCK_MARKER_PATTERN.test(match[0])) throw new RecipeError('E03E04_BLOCK_MARKER_INVALID', `preset.prompts.${prompt.identifier}`, `block marker ${match[0]} does not match ${BLOCK_MARKER_PATTERN}`);
        markers.push(match[0]);
    }
    if (new Set(markers).size !== markers.length) throw new RecipeError('E03E04_BLOCK_MARKER_DUPLICATE', 'preset.prompts[].content', 'two block prompts carry the same marker');
    const profile = preset.e03e04_profile;
    if (profile && profile.kind === PROFILE_KIND) {
        if (profile.blocks.length !== profile.blockCount) throw new RecipeError('E03E04_PRESET_BLOCK_PLAN_LENGTH', 'preset.e03e04_profile.blocks', `block plan length ${profile.blocks.length} disagrees with blockCount ${profile.blockCount}`);
        if (markers.length !== profile.blockCount) throw new RecipeError('E03E04_PRESET_BLOCK_MARKER_COUNT', 'preset.prompts[].content', `found ${markers.length} block markers for blockCount ${profile.blockCount}`);
    }
    return preset;
}

// ---------------------------------------------------------------------------------------------------------------
// WORLD-BOOK GENERATION
// ---------------------------------------------------------------------------------------------------------------

const WORLD_ENTRY_FIELDS = {
    // Field set of a world-book entry as the pinned frontend writes it (`newWorldInfoEntryTemplate`,
    // world-info.js:4937-5000 area; the three-slot kit's fixture has proved this exact shape stageable).
    addMemo: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: false,
    matchWholeWords: false,
    useGroupScoring: null,
    automationId: '',
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
    ignoreBudget: false,
    vectorized: false,
};

function worldEntry({ uid, key, content, position, order, depth = 4, role = 0, displayIndex = uid, overrides = {} }) {
    return {
        uid,
        key,
        keysecondary: [],
        comment: `e03e04 entry ${uid}`,
        content,
        constant: false,
        selective: false,
        selectiveLogic: 0,
        addMemo: false,
        order,
        position,
        disable: false,
        role,
        depth,
        ...WORLD_ENTRY_FIELDS,
        displayIndex,
        ...overrides,
    };
}

const POSITION = Object.freeze({ BEFORE: 0, AFTER: 1, AT_DEPTH: 4 });
const LOGIC = Object.freeze({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });
const DEPTH_ROLE = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });

// The books' marker/token vocabulary. Tokens are alphanumeric-only so activation does not depend on the
// whole-word/case settings a probe may stage (F5): an underscore or a space in a key would make matching
// settings-sensitive, and a settings-sensitive fixture is the "cannot discriminate" failure AGENTS.md rule 15
// names.
export const ACTIVATION_TOKENS = Object.freeze({
    chatTriggerBookB: 'E03E04BTRIGGER',
    bookBSecondary: 'E03E04BSECOND',
    bookBLink2: 'E03E04BK2',
    bookBDead: 'E03E04BDEAD',
    bookCLink1: 'E03E04CK1',
    bookCConfirm: 'E03E04CCONFIRM',
    bookCLink2: 'E03E04CK2',
    bookCLink3: 'E03E04CK3',
    bookCDead: 'E03E04CDEAD',
});

const BOOK_NAMES = Object.freeze({
    threeSlot: 'e03e04-book-a-three-slot',
    cardEmbedded: 'e03e04-card-book',
    recursiveGlobal: 'e03e04-book-c-recursive',
});

function threeSlotBook() {
    // (a) THE 3-SLOT GLOBAL BOOK: one constant entry per pinned position class (F4). `constant: true` removes
    // key matching from the activation question entirely (a key that silently fails to match is a probe defect
    // presenting as a product finding, AGENTS.md rule 10), so this book proves POSITION, not activation.
    const entries = {
        0: worldEntry({
            uid: 0,
            key: ['E03E04AKEY1'], // present but bypassed: constant activation
            position: POSITION.BEFORE,
            order: 10,
            content: `${worldMarker('A', 1)} POS=BEFORE ORDER=10 ROLE=SYSTEM`,
            overrides: { constant: true },
        }),
        1: worldEntry({
            uid: 1,
            key: ['E03E04AKEY2'],
            position: POSITION.AFTER,
            order: 20,
            content: `${worldMarker('A', 2)} POS=AFTER ORDER=20 ROLE=SYSTEM`,
            overrides: { constant: true },
        }),
        2: worldEntry({
            uid: 2,
            key: ['E03E04AKEY3'],
            position: POSITION.AT_DEPTH,
            order: 30,
            depth: 2,
            role: DEPTH_ROLE.USER,
            content: `${worldMarker('A', 3)} POS=DEPTH ORDER=30 DEPTH=2 ROLE=USER`,
            overrides: { constant: true },
        }),
    };
    return { entries };
}

function recursiveGlobalBook() {
    // (c) THE GLOBAL SECOND BOOK WITH A RECURSIVE SECONDARY-KEY CHAIN, plus two deliberate absences:
    //   C1 constant, before  -> its content carries CK1 and CONFIRM into the recursion buffer;
    //   C2 keys [CK1], secondary [CONFIRM] (AND_ALL) -> activates on recursion pass 1;
    //   C3 keys [CK2], secondary [CONFIRM] -> activates on recursion pass 2, atDepth group (3, user);
    //   C4 keys [CK3] -> activates on recursion pass 3, before slot;
    //   C5 constant with preventRecursion -> its content is NEVER buffered, so C6 (which needs CDEAD) is ABSENT.
    const entries = {
        0: worldEntry({
            uid: 0,
            key: ['E03E04CKEY1'],
            position: POSITION.BEFORE,
            order: 11,
            content: `${worldMarker('C', 1)} POS=BEFORE ORDER=11 LINK=${ACTIVATION_TOKENS.bookCLink1} CONFIRM=${ACTIVATION_TOKENS.bookCConfirm}`,
            overrides: { constant: true },
        }),
        1: worldEntry({
            uid: 1,
            key: [ACTIVATION_TOKENS.bookCLink1],
            keysecondary: [ACTIVATION_TOKENS.bookCConfirm],
            position: POSITION.AFTER,
            order: 22,
            content: `${worldMarker('C', 2)} POS=AFTER ORDER=22 LINK=${ACTIVATION_TOKENS.bookCLink2}`,
            overrides: { selective: true, selectiveLogic: LOGIC.AND_ALL },
        }),
        2: worldEntry({
            uid: 2,
            key: [ACTIVATION_TOKENS.bookCLink2],
            keysecondary: [ACTIVATION_TOKENS.bookCConfirm],
            position: POSITION.AT_DEPTH,
            order: 32,
            depth: 3,
            role: DEPTH_ROLE.USER,
            content: `${worldMarker('C', 3)} POS=DEPTH ORDER=32 DEPTH=3 ROLE=USER LINK=${ACTIVATION_TOKENS.bookCLink3}`,
            overrides: { selective: true, selectiveLogic: LOGIC.AND_ALL },
        }),
        3: worldEntry({
            uid: 3,
            key: [ACTIVATION_TOKENS.bookCLink3],
            position: POSITION.BEFORE,
            order: 13,
            content: `${worldMarker('C', 4)} POS=BEFORE ORDER=13`,
        }),
        4: worldEntry({
            uid: 4,
            key: ['E03E04CKEY5'],
            position: POSITION.BEFORE,
            order: 6,
            content: `${worldMarker('C', 5)} POS=BEFORE ORDER=6 DEAD=${ACTIVATION_TOKENS.bookCDead}`,
            overrides: { constant: true, preventRecursion: true },
        }),
        5: worldEntry({
            uid: 5,
            key: [ACTIVATION_TOKENS.bookCDead],
            position: POSITION.AFTER,
            order: 40,
            content: `${worldMarker('C', 6)} POS=AFTER ORDER=40`,
        }),
    };
    return { entries };
}

function cardEmbeddedBook() {
    // (b) THE CARD-EMBEDDED `data.character_book` PAYLOAD (F6). Spec-shaped entries: the pinned converter is
    // `convertCharacterBook` (world-info.js:5617-5674), and the activity flags are `extensions.*`. This returns
    // the PAYLOAD only; the journey kit owns the PNG staging and the probe owns the import path (F6).
    //
    //   B1 constant, before_char -> content carries BSECOND into the recursion buffer;
    //   B2 keys [BTRIGGER] (the probe's chat trigger), secondary [BSECOND] (recursion) -> activates pass 1,
    //      after_char; its content carries BK2 (chain) and BDEAD (for the absence control);
    //   B3 keys [BK2] -> activates pass 2; extensions.position = 4 (atDepth) with depth 2 role user, which also
    //      proves the extensions.position override path;
    //   B4 keys [BDEAD] with extensions.exclude_recursion = true -> ABSENT: the key only exists in recursion, and
    //      a recursion pass skips an exclude_recursion entry (world-info.js:4870-4873).
    const entries = [
        {
            id: 0,
            keys: ['E03E04BKEY1'],
            secondary_keys: [],
            comment: 'e03e04 embedded entry 0',
            content: `${worldMarker('B', 1)} POS=BEFORE ORDER=5 CONFIRM=${ACTIVATION_TOKENS.bookBSecondary}`,
            constant: true,
            selective: false,
            insertion_order: 5,
            enabled: true,
            position: 'before_char',
            case_sensitive: false,
            extensions: { position: POSITION.BEFORE, exclude_recursion: false, prevent_recursion: false, delay_until_recursion: false, depth: 4, role: DEPTH_ROLE.SYSTEM, display_index: 0, match_whole_words: false },
        },
        {
            id: 1,
            keys: [ACTIVATION_TOKENS.chatTriggerBookB],
            secondary_keys: [ACTIVATION_TOKENS.bookBSecondary],
            comment: 'e03e04 embedded entry 1',
            content: `${worldMarker('B', 2)} POS=AFTER ORDER=25 LINK=${ACTIVATION_TOKENS.bookBLink2} DEAD=${ACTIVATION_TOKENS.bookBDead}`,
            constant: false,
            selective: true,
            insertion_order: 25,
            enabled: true,
            position: 'after_char',
            case_sensitive: false,
            extensions: { position: POSITION.AFTER, selectiveLogic: LOGIC.AND_ALL, exclude_recursion: false, prevent_recursion: false, delay_until_recursion: false, depth: 4, role: DEPTH_ROLE.SYSTEM, display_index: 1, match_whole_words: false },
        },
        {
            id: 2,
            keys: [ACTIVATION_TOKENS.bookBLink2],
            secondary_keys: [],
            comment: 'e03e04 embedded entry 2',
            content: `${worldMarker('B', 3)} POS=DEPTH ORDER=31 DEPTH=2 ROLE=USER`,
            constant: false,
            selective: false,
            insertion_order: 31,
            enabled: true,
            position: 'before_char',
            case_sensitive: false,
            extensions: { position: POSITION.AT_DEPTH, depth: 2, role: DEPTH_ROLE.USER, exclude_recursion: false, prevent_recursion: false, delay_until_recursion: false, display_index: 2, match_whole_words: false },
        },
        {
            id: 3,
            keys: [ACTIVATION_TOKENS.bookBDead],
            secondary_keys: [],
            comment: 'e03e04 embedded entry 3 (must stay absent)',
            content: `${worldMarker('B', 4)} POS=AFTER ORDER=40`,
            constant: false,
            selective: false,
            insertion_order: 40,
            enabled: true,
            position: 'after_char',
            case_sensitive: false,
            extensions: { position: POSITION.AFTER, exclude_recursion: true, prevent_recursion: false, delay_until_recursion: false, display_index: 3, match_whole_words: false },
        },
    ];
    return {
        name: BOOK_NAMES.cardEmbedded,
        description: 'synthetic embedded lorebook for the e03e04 profile',
        scan_depth: 2,
        token_budget: 512,
        recursive_scanning: true,
        extensions: { e03e04: { kind: PROFILE_KIND, schemaVersion: PROFILE_SCHEMA_VERSION } },
        entries,
    };
}

/**
 * BUILD THE THREE BOOKS. `buildBooks({ seed })` returns:
 *   - `threeSlot`:       the 3-slot global world book document (`{ entries }`), stageable like
 *                        `worldinfo-slots-kit.mjs`'s `stageWorldBook` writes it;
 *   - `cardEmbedded`:    the `{ characterBook }` payload for a V3 card's `data.character_book` (F6);
 *   - `recursiveGlobal`: the second global world book with the recursive secondary-key chain.
 * Plus `selection` (the persisted globalSelect), `worldInfoSettings` (the settings members a deterministic scan
 * needs), and `activation` (trigger tokens, per-entry activation cause, and the two deliberate absences).
 *
 * The books are seeded only for the marker vocabulary's provenance; the entry layout itself is fixed by the
 * profile (a book whose entry ORDER depended on the seed could not be compared against the fixture's own order).
 */
export function buildBooks(recipeInput) {
    if (recipeInput === null || typeof recipeInput !== 'object' || Array.isArray(recipeInput)) {
        throw new RecipeError('E03E04_BOOKS_RECIPE_NOT_AN_OBJECT', 'books', 'buildBooks expects { seed }');
    }
    for (const key of Object.keys(recipeInput)) {
        if (key !== 'seed') throw new RecipeError('E03E04_BOOKS_RECIPE_UNKNOWN_FIELD', key, 'buildBooks accepts only { seed }');
    }
    const seed = validateSeed(recipeInput.seed);
    const threeSlot = { name: BOOK_NAMES.threeSlot, kind: 'global-three-slot', document: threeSlotBook() };
    const recursiveGlobal = { name: BOOK_NAMES.recursiveGlobal, kind: 'global-recursive', document: recursiveGlobalBook() };
    const cardEmbedded = { name: BOOK_NAMES.cardEmbedded, kind: 'card-embedded', characterBook: cardEmbeddedBook() };

    return {
        kind: 'e03e04-books',
        schemaVersion: PROFILE_SCHEMA_VERSION,
        seed,
        threeSlot,
        cardEmbedded,
        recursiveGlobal,
        selection: {
            // `world_info.globalSelect` is the product's own storage for "these worlds are active"
            // (world-info.js:995-998); the card-embedded book is NOT selectable this way -- the probe must drive
            // `checkEmbeddedWorld` (F6) or record the embedded path as unproven.
            globalSelect: [BOOK_NAMES.threeSlot, BOOK_NAMES.recursiveGlobal],
            embeddedBookImportName: BOOK_NAMES.cardEmbedded,
        },
        worldInfoSettings: {
            world_info: { globalSelect: [BOOK_NAMES.threeSlot, BOOK_NAMES.recursiveGlobal] },
            world_info_depth: 2,
            world_info_budget: 25,
            world_info_include_names: true,
            world_info_recursive: true,
            // A bound, not a budget: the chain finishes in three recursion passes and the loop stops itself when
            // nothing new activates (F5). A too-small bound would truncate the chain, which is exactly the
            // truncation hazard a deterministic fixture must record instead of hide.
            world_info_max_recursion_steps: 10,
            world_info_overflow_alert: false,
            world_info_case_sensitive: false,
            world_info_match_whole_words: false,
            world_info_character_strategy: 1,
            world_info_budget_cap: 0,
        },
        activation: {
            chatTriggerTokens: [ACTIVATION_TOKENS.chatTriggerBookB],
            chain: [
                { book: BOOK_NAMES.cardEmbedded, marker: worldMarker('B', 1), step: 0, cause: 'constant' },
                { book: BOOK_NAMES.cardEmbedded, marker: worldMarker('B', 2), step: 1, cause: `primary key ${ACTIVATION_TOKENS.chatTriggerBookB} in the scanned chat AND secondary key ${ACTIVATION_TOKENS.bookBSecondary} from the recursion buffer` },
                { book: BOOK_NAMES.cardEmbedded, marker: worldMarker('B', 3), step: 2, cause: `primary key ${ACTIVATION_TOKENS.bookBLink2} from the recursion buffer` },
                { book: BOOK_NAMES.recursiveGlobal, marker: worldMarker('C', 1), step: 0, cause: 'constant' },
                { book: BOOK_NAMES.recursiveGlobal, marker: worldMarker('C', 2), step: 1, cause: `secondary-key chain: primary ${ACTIVATION_TOKENS.bookCLink1} and secondary ${ACTIVATION_TOKENS.bookCConfirm} both from the recursion buffer` },
                { book: BOOK_NAMES.recursiveGlobal, marker: worldMarker('C', 3), step: 2, cause: `primary key ${ACTIVATION_TOKENS.bookCLink2} from the recursion buffer, secondary ${ACTIVATION_TOKENS.bookCConfirm}` },
                { book: BOOK_NAMES.recursiveGlobal, marker: worldMarker('C', 4), step: 3, cause: `primary key ${ACTIVATION_TOKENS.bookCLink3} from the recursion buffer` },
                { book: BOOK_NAMES.recursiveGlobal, marker: worldMarker('C', 5), step: 0, cause: 'constant, preventRecursion (its content never enters the recursion buffer)' },
            ],
            expectedAbsent: [
                { book: BOOK_NAMES.cardEmbedded, marker: worldMarker('B', 4), reason: `key ${ACTIVATION_TOKENS.bookBDead} exists only in an entry's recursion-buffer content, and this entry has exclude_recursion: true, so a RECURSION pass skips it (world-info.js:4870-4873)` },
                { book: BOOK_NAMES.recursiveGlobal, marker: worldMarker('C', 6), reason: `key ${ACTIVATION_TOKENS.bookCDead} exists only in a preventRecursion entry's content, and a preventRecursion entry's content is never added to the recursion buffer (world-info.js:5080)` },
            ],
            determinismNotes: [
                'every entry uses probability 100 / useProbability true: no random roll can drop an entry',
                'sticky/cooldown/delay are null: no timed effect can change the first generation',
                'every entry has matchWholeWords false and caseSensitive false: activation does not depend on the settings default',
                'every entry has a globally unique order: the slot sequence is total (F4)',
                'all keys are alphanumeric tokens: no regex/whole-word boundary ambiguity',
            ],
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------
// SETTINGS PATCH (the members that are NOT in the preset file, F7)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The settings.json patch that makes the environment coherent with the generated documents:
 *   - world-info selection and recursion under BOTH layouts: `world_info_settings` (the pinned default tree) and
 *     the top-level mirror (`script.js:8013` calls `setWorldInfoSettings(settings.world_info_settings ?? settings)`),
 *     so a tree with either layout reads the same selection;
 *   - `power_user.custom_stopping_strings` as the JSON STRING the frontend parses (F7), with macro expansion off
 *     so the stops cannot textually change between runs;
 *   - `power_user.instruct` / `power_user.context` template members (F7). They are declared `enabled: false`
 *     (instruct) and recorded as no-wire-effect on the chat-completion path; the probe must not invent a marker
 *     for them.
 */
export function buildSettingsPatch({ preset, books }) {
    if (!preset || !preset.e03e04_profile) throw new RecipeError('E03E04_SETTINGS_PRESET_INVALID', 'preset', 'buildSettingsPatch needs a preset document from buildPreset()');
    if (!books || books.kind !== 'e03e04-books') throw new RecipeError('E03E04_SETTINGS_BOOKS_INVALID', 'books', 'buildSettingsPatch needs a books object from buildBooks()');
    const profile = presetProfile(preset);
    if (profile.seed !== books.seed) throw new RecipeError('E03E04_SETTINGS_SEED_MISMATCH', 'books.seed', `preset seed ${profile.seed} and books seed ${books.seed} disagree`);
    const worldInfoSettings = structuredClone(books.worldInfoSettings);
    const { name: instructName, ...instructFields } = preset.instruct;
    const { name: contextName, ...contextFields } = preset.context;
    return {
        world_info_settings: worldInfoSettings,
        // Mirror for a settings tree whose `world_info_settings` member is absent (script.js:8013 `?? settings`).
        ...structuredClone(worldInfoSettings),
        power_user: {
            custom_stopping_strings: JSON.stringify(preset.stop_strings),
            custom_stopping_strings_macro: false,
            // `power_user.instruct` is an inline object in the pinned default settings.json (`enabled`, `preset`,
            // then the template fields); the template FILE shape carries `name` instead of `preset`, so the name
            // is moved into `preset` and not duplicated.
            instruct: { enabled: false, preset: instructName, ...instructFields },
            context: { preset: contextName, ...contextFields },
        },
        e03e04_profile: {
            kind: PROFILE_KIND,
            schemaVersion: PROFILE_SCHEMA_VERSION,
            seed: profile.seed,
            blockCount: profile.blockCount,
            tier: profile.tier,
            wireEffect: {
                worldInfo: 'selection + recursive scan settings reach the world-info scan',
                stopStrings: 'power_user.custom_stopping_strings reaches the provider stop array (openai.js:2814)',
                instructTemplate: 'no-wire-effect: text-completion side only (F7)',
                contextTemplate: 'no-wire-effect: text-completion side only (F7)',
            },
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------
// THE ORDERED MARKER MANIFEST
// ---------------------------------------------------------------------------------------------------------------

function assertBooks(books) {
    if (books === null || typeof books !== 'object' || books.kind !== 'e03e04-books') throw new RecipeError('E03E04_BOOKS_INVALID', 'books', 'expectedOrder needs a books object from buildBooks()');
    for (const key of ['threeSlot', 'recursiveGlobal']) {
        const book = books[key];
        if (!book || !book.document || !book.document.entries) throw new RecipeError('E03E04_BOOKS_MISSING_BOOK', `books.${key}`, 'a generated world-book document is missing');
    }
    if (!books.cardEmbedded || !books.cardEmbedded.characterBook || !Array.isArray(books.cardEmbedded.characterBook.entries)) throw new RecipeError('E03E04_BOOKS_MISSING_BOOK', 'books.cardEmbedded', 'the card-embedded character_book payload is missing');
    return books;
}

function entriesOfDocument(document) {
    return Object.keys(document.entries)
        .map(key => document.entries[key])
        .sort((a, b) => a.uid - b.uid);
}

/**
 * Convert ONE V3 `data.character_book` entry to the world-entry shape the pinned converter produces
 * (`world-info.js:5626-5670`). This is a local restatement of the pinned mapping used only so the manifest can
 * read an embedded entry's position/order/depth/role; it is not a second implementation of import.
 */
function embeddedEntryToWorldEntry(entry, index) {
    const extensions = entry.extensions ?? {};
    const position = Number.isInteger(extensions.position)
        ? extensions.position
        : (entry.position === 'before_char' ? POSITION.BEFORE : POSITION.AFTER);
    return {
        uid: entry.id ?? index,
        order: entry.insertion_order ?? 0,
        position,
        depth: extensions.depth ?? 4,
        role: extensions.role ?? DEPTH_ROLE.SYSTEM,
        constant: entry.constant === true,
        selective: entry.selective === true,
        excludeRecursion: extensions.exclude_recursion === true,
        preventRecursion: extensions.prevent_recursion === true,
        content: String(entry.content ?? ''),
    };
}

/** Expand a world book's entries into the pinned position classes (F4), marking each marker once. */
function expandBook(bookName, kind, entries) {
    const before = [];
    const after = [];
    const depth = [];
    const markers = [];
    for (const entry of entries) {
        const match = String(entry.content ?? '').match(WORLD_MARKER_FIND);
        if (!match) throw new RecipeError('E03E04_BOOK_ENTRY_MARKER_MISSING', `${bookName}.entries.${entry.uid}`, 'every world entry needs a MARKER_Wxxxx in its content');
        const marker = match[0];
        markers.push({ marker, book: bookName, order: entry.order, position: entry.position, depth: entry.depth, role: entry.role, constant: entry.constant === true, selective: entry.selective === true, excludeRecursion: entry.excludeRecursion === true, preventRecursion: entry.preventRecursion === true });
        const detail = { marker, book: bookName, order: entry.order, position: entry.position, depth: entry.depth, role: entry.role };
        if (entry.position === POSITION.BEFORE) before.push(detail);
        else if (entry.position === POSITION.AFTER) after.push(detail);
        else if (entry.position === POSITION.AT_DEPTH) depth.push(detail);
        else throw new RecipeError('E03E04_BOOK_ENTRY_POSITION', `${bookName}.entries.${entry.uid}`, `unsupported position ${String(entry.position)}`);
    }
    const ascending = list => list.slice().sort((a, b) => a.order - b.order).map(item => item.marker);
    const depthGroups = new Map();
    for (const entry of depth) {
        const key = `${entry.depth}:${entry.role}`;
        if (!depthGroups.has(key)) depthGroups.set(key, []);
        depthGroups.get(key).push(entry);
    }
    return {
        book: bookName,
        kind,
        markers,
        slots: {
            // Ascending by `order` INSIDE a slot class: pinned iterates descending and unshifts, so the joined
            // text is ascending (F4). The kit's globally unique orders make this a total order.
            before: ascending(before),
            after: ascending(after),
            depth: [...depthGroups.entries()].map(([key, group]) => {
                const [depthValue, roleValue] = key.split(':').map(Number);
                return { depth: depthValue, role: roleValue, markers: ascending(group) };
            }),
        },
    };
}

/** An absolute preset block's expected content order inside its depth/role group is DESCENDING injection_order. */
function absoluteGroups(blocks) {
    const groups = new Map();
    for (const block of blocks) {
        const key = `${block.injectionDepth}:${block.role}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(block);
    }
    return [...groups.entries()]
        .sort(([a], [b]) => {
            const [depthA] = a.split(':').map(Number);
            const [depthB] = b.split(':').map(Number);
            return depthA - depthB || compareCodeUnits(a, b);
        })
        .map(([key, group]) => {
            const [depthValue, roleName] = key.split(':');
            const ordered = group.slice().sort((a, b) => b.injectionOrder - a.injectionOrder);
            return { depth: Number(depthValue), role: roleName, markers: ordered.map(item => item.marker) };
        });
}

/**
 * THE SINGLE ORDERED MARKER MANIFEST the probe records and the comparator compares.
 *
 * `sequence` is the flat order of every marker whose position follows from `prompt_order` ALONE (F3): the
 * world-before slot expansion at its prompt_order index, every enabled RELATIVE block marker at its own
 * prompt_order index, and the world-after slot expansion at its prompt_order index. The world-entry expansion
 * inside a slot is ascending by the entry's `order` (F4).
 *
 * `history` carries the markers whose absolute index depends on the chat length the DRIVE owns: absolute
 * (in-chat) preset blocks grouped by (depth, role) with descending injection_order (openai.js:819-871), and
 * world-info atDepth entries grouped by (depth, role). This module records the REQUESTED depth and does not
 * invent an offset: the pinned leg measures it (the pattern already established by the three-slot kit).
 *
 * `absent` lists every marker that must appear ZERO times: declared-disabled blocks, trigger-excluded blocks, and
 * the books' deliberate recursion-absence controls. That list is the half of AGENTS.md rule 48 that keeps a
 * "120 blocks" fixture from being a parse test.
 */
export function expectedOrder({ preset, books }) {
    assertPresetDocument(preset);
    assertBooks(books);
    const profile = presetProfile(preset);
    const order = preset.prompt_order[0].order;
    const promptsByIdentifier = new Map(preset.prompts.map(prompt => [prompt.identifier, prompt]));
    const planByIdentifier = new Map(profile.blocks.map(block => [block.identifier, block]));

    if (planByIdentifier.size !== profile.blockCount) throw new RecipeError('E03E04_PRESET_BLOCK_PLAN_DUPLICATE', 'preset.e03e04_profile.blocks', 'the block plan has duplicate identifiers');

    const world = {
        threeSlot: expandBook(books.threeSlot.name, books.threeSlot.kind, entriesOfDocument(books.threeSlot.document)),
        recursiveGlobal: expandBook(books.recursiveGlobal.name, books.recursiveGlobal.kind, entriesOfDocument(books.recursiveGlobal.document)),
        cardEmbedded: expandBook(books.cardEmbedded.name, books.cardEmbedded.kind, books.cardEmbedded.characterBook.entries.map(embeddedEntryToWorldEntry)),
    };
    // Cross-book marker uniqueness: a duplicate marker would make attribution ambiguous, so it is refused rather
    // than compared.
    const worldMarkers = Object.values(world).flatMap(book => book.markers.map(marker => marker.marker));
    if (new Set(worldMarkers).size !== worldMarkers.length) throw new RecipeError('E03E04_WORLD_MARKER_DUPLICATE', 'books', 'two world entries carry the same marker');

    // The flat manifest is built by walking prompt_order. A world slot expands to ALL selected books' entries of
    // that class, ascending by order (F4). The card book's entries join the same channels once imported (F6).
    // The books' deliberate absence controls must NOT expand into a slot: a marker the recipe declares absent is
    // filtered out of every present bucket here, and listed only in `absent`.
    const declaredAbsent = new Set(books.activation.expectedAbsent.map(absence => absence.marker));
    const allBefore = Object.values(world).flatMap(book => book.slots.before.map(marker => ({ marker, detail: book.markers.find(entry => entry.marker === marker) }))).filter(item => !declaredAbsent.has(item.marker));
    const allAfter = Object.values(world).flatMap(book => book.slots.after.map(marker => ({ marker, detail: book.markers.find(entry => entry.marker === marker) }))).filter(item => !declaredAbsent.has(item.marker));
    const beforeSequence = allBefore.slice().sort((a, b) => a.detail.order - b.detail.order);
    const afterSequence = allAfter.slice().sort((a, b) => a.detail.order - b.detail.order);

    const sequence = [];
    const absent = [];
    const absoluteBlocks = [];
    const relativeBlocks = [];
    let historyIndex = null;
    for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
        const entry = order[orderIndex];
        const block = planByIdentifier.get(entry.identifier);
        if (entry.identifier === 'worldInfoBefore') {
            for (const item of beforeSequence) sequence.push({ marker: item.marker, kind: 'world-before', book: item.detail.book ?? null, order: item.detail.order, role: 'system', orderIndex });
        } else if (entry.identifier === 'worldInfoAfter') {
            for (const item of afterSequence) sequence.push({ marker: item.marker, kind: 'world-after', book: item.detail.book ?? null, order: item.detail.order, role: 'system', orderIndex });
        } else if (block) {
            if (!block.absolute && entry.enabled && !block.disabled && !block.triggerExcluded) {
                sequence.push({ marker: block.marker, kind: 'preset-block', identifier: block.identifier, role: block.role, orderIndex });
                relativeBlocks.push(block);
            } else if (block.absolute && entry.enabled && !block.disabled && !block.triggerExcluded) {
                absoluteBlocks.push(block);
            } else if (block.disabled) {
                absent.push({ marker: block.marker, reason: 'declared disabled in prompt_order (index % 3 === 0)' });
            } else if (block.triggerExcluded) {
                absent.push({ marker: block.marker, reason: 'enabled in prompt_order but injection_trigger [\'continue\'] excludes it from a normal generation (PromptManager.js:1549-1555)' });
            }
        }
        if (entry.identifier === 'chatHistory') historyIndex = orderIndex;
    }

    // A block whose prompt legally exists but that never reached an enabled relative/absolute bucket is an
    // internal inconsistency: refuse rather than silently leave it out of the manifest.
    const accounted = relativeBlocks.length + absoluteBlocks.length;
    if (accounted + absent.length !== profile.blockCount) {
        throw new RecipeError('E03E04_PRESET_BLOCK_ACCOUNTING', 'preset', `block accounting mismatch: ${accounted} present + ${absent.length} absent != ${profile.blockCount}`);
    }

    for (const absence of books.activation.expectedAbsent) absent.push({ marker: absence.marker, reason: absence.reason });

    // The depth-channel groups are part of the PRESENT manifest; every marker must land in exactly one present
    // bucket (sequence, absolute blocks, depth groups) or in `absent`, so attribution is unambiguous.
    const depthEntries = Object.keys(world).flatMap(key => world[key].slots.depth.map(group => ({ book: world[key].book, depth: group.depth, role: group.role, markers: group.markers.filter(marker => !declaredAbsent.has(marker)) })));
    const presentMarkers = [
        ...sequence.map(item => item.marker),
        ...absoluteBlocks.map(block => block.marker),
        ...depthEntries.flatMap(group => group.markers),
    ];
    if (new Set(presentMarkers).size !== presentMarkers.length) throw new RecipeError('E03E04_MANIFEST_MARKER_DUPLICATE', 'expectedOrder', 'a marker appears twice in the present manifest');
    const absentMarkers = absent.map(item => item.marker);
    if (new Set(absentMarkers).size !== absentMarkers.length) throw new RecipeError('E03E04_MANIFEST_ABSENT_DUPLICATE', 'expectedOrder.absent', 'an absent marker is listed twice');
    for (const marker of absentMarkers) {
        if (presentMarkers.includes(marker)) throw new RecipeError('E03E04_MANIFEST_CONTRADICTION', `expectedOrder.${marker}`, 'a marker is listed as both present and absent');
    }
    // Book-entry coverage: a world marker that is neither present nor explicitly absent would be a marker the
    // probe could never attribute, which is exactly the silent gap this manifest exists to prevent.
    for (const marker of worldMarkers) {
        if (!presentMarkers.includes(marker) && !absentMarkers.includes(marker)) {
            throw new RecipeError('E03E04_MANIFEST_UNACCOUNTED_WORLD_MARKER', `expectedOrder.${marker}`, 'a world entry marker is neither present nor absent in the manifest');
        }
    }
    for (const marker of [...presentMarkers, ...absentMarkers]) {
        if (!MARKER_PATTERN.test(marker)) throw new RecipeError('E03E04_MANIFEST_MARKER_INVALID', 'expectedOrder', `marker ${marker} does not match ${MARKER_PATTERN}`);
    }

    return {
        kind: 'e03e04-expected-order',
        schemaVersion: PROFILE_SCHEMA_VERSION,
        seed: profile.seed,
        blockCount: profile.blockCount,
        tier: profile.tier,
        totalPromptCount: profile.totalPromptCount,
        sequence,
        history: {
            historyStartsAfterOrderIndex: historyIndex,
            historyPositionRule: 'every marker in `history` appears after the markers in `sequence`; their absolute index depends on the chat length the drive owns, so the probe asserts distance-from-end (measured on the pinned leg) and the comparator names this rule in a red',
            absoluteBlocks: absoluteGroups(absoluteBlocks),
            depthEntries,
        },
        blocks: {
            enabledRelative: relativeBlocks.map(block => block.marker),
            enabledAbsolute: absoluteBlocks.map(block => block.marker),
            disabled: absent.filter(item => item.reason.startsWith('declared disabled')).map(item => item.marker),
            triggerExcluded: absent.filter(item => item.reason.startsWith('enabled in prompt_order')).map(item => item.marker),
            roleRuns: profile.roleRuns,
        },
        worldBooks: Object.fromEntries(Object.entries(world).map(([key, book]) => [key, {
            name: book.book,
            kind: book.kind,
            slots: { before: book.slots.before, after: book.slots.after, depth: book.slots.depth },
            markers: book.markers.map(marker => ({ marker: marker.marker, order: marker.order, position: marker.position, depth: marker.depth, role: marker.role })),
            expectedAbsent: books.activation.expectedAbsent.filter(absence => absence.book === book.book).map(absence => absence.marker),
        }])),
        absent,
        activation: books.activation,
        orderingRules: {
            relativeBlocks: 'the enabled relative block markers follow prompt_order, which is the relative-prompt message order (PromptManager.js:1516-1541 + openai.js:1240-1257, 1187-1208)',
            worldSlots: 'within a slot class, entries are ascending by `order`: pinned iterates descending and unshifts (world-info.js:88, 5203-5263), and this kit makes every order globally unique',
            depthGroups: 'grouped by (depth, role); the group text is ascending by `order`, and the group is spliced into the history at its requested depth (openai.js:819-871)',
            absoluteBlocks: 'grouped by (depth, role); the joined group text is DESCENDING injection_order (openai.js:820-864), then spliced at the requested depth',
            sequenceScope: 'sequence is every marker whose position follows from prompt_order alone; history markers are asserted by distance-from-end',
        },
        sourceFacts: {
            F1: 'openai.js:305-409,5046-5065 (preset key table)',
            F2: 'PromptManager.js:80-199,2001-2081,2087-2136,312-339 (prompt/order shape, dummyId 100000)',
            F3: 'PromptManager.js:1516-1555,445-450,1667-1668 + openai.js:1187-1257 (prompt_order is the assembly order)',
            F4: 'world-info.js:88,855-864,5203-5263,5235-5246 (positions, ascending slot order)',
            F5: 'world-info.js:4766-4777,4870-4897,4924-4984,5080,5097-5144 (recursion, secondary keys, absent controls)',
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------
// THE ONE-CALL PROFILE
// ---------------------------------------------------------------------------------------------------------------

/**
 * Build every ingredient in one deterministic call, plus the manifest that records the seed and the sha256 of
 * every generated document (design section 4.1: "the manifest records the seed and the sha256 of every generated
 * document"). `digest` is `sha256(canonicalJson(document))`; `bytes` is `documentBytes(document)`, the canonical
 * bytes a staging writer must put on disk.
 */
export function buildProfile(recipeInput) {
    const recipe = validateRecipe(recipeInput);
    const preset = buildPreset(recipe);
    const books = buildBooks({ seed: recipe.seed });
    const settings = buildSettingsPatch({ preset, books });
    const order = expectedOrder({ preset, books });
    const summarise = (value, extra) => ({
        sha256: sha256(canonicalJson(value)),
        byteLength: Buffer.byteLength(documentBytes(value), 'utf8'),
        ...extra,
    });
    return {
        kind: PROFILE_KIND,
        schemaVersion: PROFILE_SCHEMA_VERSION,
        recipe,
        preset,
        books,
        settings,
        expectedOrder: order,
        manifest: {
            kind: `${PROFILE_KIND}-manifest`,
            schemaVersion: PROFILE_SCHEMA_VERSION,
            seed: recipe.seed,
            blockCount: recipe.blockCount,
            tier: recipe.tier,
            committedMaxima: COMMITTED_MAXIMA,
            claim: {
                generatedBlocks: recipe.blockCount,
                totalPrompts: preset.e03e04_profile.totalPromptCount,
                exceedsCommittedMaxima: preset.e03e04_profile.totalPromptCount > COMMITTED_MAXIMA.presetB.prompts && recipe.blockCount >= 120,
                statement: `${preset.e03e04_profile.totalPromptCount} declared prompts (${PINNED_DEFAULT_PROMPTS.length} pinned defaults + ${recipe.blockCount} generated blocks) versus committed preset-a ${COMMITTED_MAXIMA.presetA.prompts} / preset-b ${COMMITTED_MAXIMA.presetB.prompts} / journey corpus <= ${COMMITTED_MAXIMA.journeyCorpus.maxPrompts}`,
            },
            documents: {
                preset: summarise(preset, { fileName: 'e03e04-profile.json', directoryKey: 'openAI_Settings' }),
                threeSlotBook: summarise(books.threeSlot.document, { fileName: `${books.threeSlot.name}.json`, directoryKey: 'worlds' }),
                recursiveGlobalBook: summarise(books.recursiveGlobal.document, { fileName: `${books.recursiveGlobal.name}.json`, directoryKey: 'worlds' }),
                cardCharacterBook: summarise(books.cardEmbedded.characterBook, { embeddedInCard: 'data.character_book', owner: 'combination-journey-kit.mjs PNG staging' }),
                settingsPatch: summarise(settings, { note: 'merged into settings.json before boot; both world_info_settings and its top-level mirror are present' }),
                expectedOrder: summarise(order, { note: 'recorded beside each leg; the comparator consumes it' }),
            },
        },
    };
}
