#!/usr/bin/env node
// REFUSE TO SHIP A FIXTURE THAT CARRIES A WATERMARK.
//
// The user's own instruction, recorded because it is a product constraint rather than a preference:
// "does the committed fixture contain hidden watermarks -- for example my Discord account?"
//
// tools/build-real-fixtures.mjs replaces prose, script bodies and every identity field -- for a preset, the
// prompt/regex/helper names and the label subtrees; for a card, `name`/`creator`/`creator_notes`/`tags`/the
// alternate greetings/`character_book.name` and everything else CARD_IDENTITY_FIELDS names. This tool checks
// what SURVIVES: handles, URLs, credits, and any name field that did not receive a marker. Classes are matched
// case-SENSITIVELY per class, because an insensitive '@' matches SillyTavern's own '@api/users' and an
// insensitive '/Users/' matches GET /api/users/me -- a sweep that turns into a phantom defect (AGENTS.md 18's
// lesson, applied to a leak scan).
//
// THE CARD CONTENT CHECK (AGENTS.md 56, the user asked explicitly). A card additionally requires a content
// check for "material that violates a platform's rules", which is why `build-real-fixtures.mjs` refused every
// card by name until this pass existed. The check is DELIBERATELY NOT A SEMANTIC JUDGEMENT: it refuses a
// fixture that carries an EXPLICIT token from the list below, says which token and which class, and does
// nothing else. A semantic judgement about a user's prose is not this tool's job and no regular expression can
// make one; a short, explicit, reviewable token list can be, and it is the thing the user asked for. Every
// token is data, printed by `--classes`, so a reviewer reads the same list the gate runs.
//
// Usage:
//   node tools/check-fixture-watermarks.mjs <file> [<file> ...]
//   node tools/check-fixture-watermarks.mjs --allow-declared <manifest.json> <file> ...
//   node tools/check-fixture-watermarks.mjs --classes      # print the class lists and exit
//
// Exit 2 names the file, the class and the offending text.

import fs from 'node:fs';

const CLASSES = [
    ['a URL', /https?:\/\/[^\s"'\\]+/],
    ['a Discord handle or invite', /discord(?:app)?\.(?:gg|com)|discord/i],
    // THE E-MAIL PATTERN IS BOUNDED, AND THAT IS A MEASURED FIX RATHER THAN TIDINESS. The natural form
    // `[\w.+-]+@[\w-]+\.[a-z]{2,}` is quadratic on a long run with no `@`: measured 93 s on a 200 KB base64
    // sample, and a committed card is 9.25 MB of base64 in one tEXt chunk, so the scanner would have wedged the
    // CI job it exists to protect (the first real build had to be killed after four minutes with no output, and
    // the stage timing put it here). Each bounded quantifier makes the scan linear; an address longer than its
    // bound is not an address a card carries, and the URL class and the survivor sweep catch the rest.
    ['an e-mail address', /\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}\b/],
    ['a QQ group or handle', /qq\.com|QQ群|群号|加群/],
    ['a support/creator platform', /bilibili|patreon|afdian|爱发电|米游社|kofi|ko-fi/i],
    ['a creator credit', /作者|署名|制作人|汉化|转载|禁止转载|侵删/],
    ['a chat handle', /微信|VX号|vx号/],
];

// THE CONTENT CLASSES: an explicit adult/NSFW marker, refused by TOKEN, never by inference.
//
// WHY THESE TOKENS AND NOT MORE: each is a word whose presence in a fixture is itself the finding -- an
// explicit act named directly, or a platform's own NSFW flag. Where a token is a short word that occurs
// inside innocent words ("cum" in "circumference", "cock" in "peacock") it is left OUT rather than anchored,
// because an anchored form that misses `cocked` while matching `cock` is a rule whose behaviour nobody can
// predict from reading it. A wider list would be a semantic judgement dressed as a token list, which is
// exactly what this class must not be.
export const CONTENT_CLASSES = [
    // The platform flags a card carries. `nsfw: true` is the author declaring the card adult.
    ['an NSFW platform flag', /"(?:nsfw|is_nsfw|explicit|mature)"\s*:\s*true\b/i],
    ['an explicit-tag marker', /"(?:sexual_content|explicit_sexual_content)"\s*:\s*true\b/i],
    // Acts, named directly.
    ['explicit sexual content', /\b(?:sexual intercourse|cunnilingus|fellatio|vaginal sex|anal sex|masturbat(?:e|es|ed|ing|ion)|ejaculat(?:e|es|ed|ing|ion)|orgasm(?:s|ed|ing)?|penetrat(?:e|es|ed|ing|ion)|erotic(?:a|ally)?)\b/i],
    // Explicit anatomy in a sexual context.
    ['explicit sexual anatomy', /\b(?:penis|genitals?|genitalia|vulva|pussy)\b/i],
    // The tags a platform bans outright, where the tag itself is the finding.
    ['a banned-fetish tag', /\b(?:underage|shota|loli|incest|bestiality|zoophilia|necrophilia)\b/i],
];

// MARKER TIERS. MARK_NNNNNN is eleven bytes where a field has room; MNNNNNN is seven and is the short form. A
// SIX-byte tier was measured and refused: Mk0001 is exactly the shape of a two-character CJK name such as the
// six-byte directive in preset A, so a real name could satisfy the gate.
//
// THE THIRD TIER IS `#\d+` FILLING THE FIELD EXACTLY, and it exists because a real card carries identity fields
// shorter than seven bytes (this repository's own card builder writes `personality: 'calm'`, and the real card's
// `character_version` and `tags` entries run 2-10 bytes). The six-byte tier was refused because `Mk0001` is
// `letter + letters + digits`, which is the SHAPE of a real short name; this tier is refused for a name by
// requiring a LEADING `#`, and the self-test proves the distinction by feeding it the exact values the six-byte
// tier could not exclude (`勿动`, `female`, `1`, `calm`, `abc`) and requiring each to be refused. The tier also
// has to consume the field EXACTLY, so `#1a` and `#abc` are not markers.
const MARKER_FORMS = [/MARK_\d{6}/, /M\d{6}/];
// THE SHORT TIER: `#`, or `#` followed by digits, consuming the field EXACTLY. The bare `#` is the 1-byte tier
// (measured: the real card's `character_book.entries.8.keys[2]` is `K`).
const SHORT_MARKER = /^#\d*$/;
// Filler characters a name may be padded with after the marker: the generator uses 'x' and the CJK test char.
const FILLER_TAIL = /^[x测]*$/;

const isMarkerPrefixed = (value) => SHORT_MARKER.test(value) || MARKER_FORMS.some((form) => {
    const match = new RegExp('^' + form.source).exec(value);
    if (!match) return false;
    return FILLER_TAIL.test(value.slice(match[0].length));
});
const isMarkerOnly = (value) => SHORT_MARKER.test(value) || MARKER_FORMS.some((form) => new RegExp('^' + form.source + '$').test(value));

// EXPORTED SO THE SELF-TEST EXERCISES THE REAL PREDICATE rather than a copy of it (differential doctrine 3: the
// subject and the oracle may not share an expectation, and a self-test that re-implements the rule tests the
// copy). The `--marker` CLI mode below additionally drives it through the program a reviewer runs.
export const isIdentityMarker = (value) => isMarkerPrefixed(value) || isMarkerOnly(value);
const normalize = (pathName) => pathName.replace(/\[(\d+)\]/g, function (match, index) { return '.' + index; });

// ------------------------------------------------------------------------------------------------
// THE ONE SCANNER. `scanText` is exported so the GENERATOR runs the identical gate before it writes a
// fixture (a generator that writes a file its own gate would refuse has a hole), and so a refusal is proven
// against the same implementation CI runs rather than against a copy of it.
//
// It returns findings rather than exiting, so both callers decide. Every finding names its class and the
// offending text, truncated: a refusal that says "something matched" is not reviewable.
// ------------------------------------------------------------------------------------------------
export function scanText(text, { file = '<memory>' } = {}) {
    const findings = [];
    const add = (message) => findings.push(`${file}: ${message}`);

    for (const [name, pattern] of CLASSES) {
        const match = pattern.exec(text);
        if (match) add('carries ' + name + ': ' + JSON.stringify(match[0].slice(0, 120)));
    }

    // The content check. Reported with a CONTENT: prefix of its own, because a reader needs to know whether a
    // fixture was refused for a handle or for platform-prohibited material: they have different remedies
    // (redact a name vs. do not derive from this card at all).
    for (const [name, pattern] of CONTENT_CLASSES) {
        const match = pattern.exec(text);
        if (match) add('CONTENT: carries ' + name + ': ' + JSON.stringify(match[0].slice(0, 120)));
    }

    const longStrings = [...text.matchAll(/"([^"\\]{64,})"/g)].map((entry) => entry[1]);
    const unmarked = longStrings.filter((value) => !MARKER_FORMS.some((form) => form.test(value)));
    if (unmarked.length > 0) {
        add('has ' + unmarked.length + ' string(s) of 64+ characters with no marker, so a substitution did not run: ' + JSON.stringify(unmarked[0].slice(0, 120)));
    }

    return { ok: findings.length === 0, findings };
}

// THE NAME FIELDS, PATH BY PATH. Preset and card fields are the same rule, so one walker handles both: a
// fixture is either a preset document (top-level `prompts`, `extensions.*`) or a card document (its identity
// fields under `data`). Only NON-EMPTY values are checked: an empty `comment` carries nothing.
export function nameFields(parsed, isCard) {
    const fields = [];
    const push = (pathName, value) => { if (typeof value === 'string' && value.length > 0) fields.push([pathName, value]); };
    if (isCard) {
        const data = parsed?.data ?? {};
        push('name', data.name);
        push('creator', data.creator);
        push('creator_notes', data.creator_notes);
        push('character_version', data.character_version);
        for (const [index, tag] of (Array.isArray(data.tags) ? data.tags : []).entries()) push('tags[' + index + ']', tag);
        push('character_book.name', data.character_book?.name);
        for (const [index, entry] of (Array.isArray(data.character_book?.entries) ? data.character_book.entries : []).entries()) {
            push('character_book.entries[' + index + '].comment', entry?.comment);
            push('character_book.entries[' + index + '].name', entry?.name);
            for (const [keyIndex, key] of (Array.isArray(entry?.keys) ? entry.keys : []).entries()) push('character_book.entries[' + index + '].keys[' + keyIndex + ']', key);
            for (const [keyIndex, key] of (Array.isArray(entry?.secondary_keys) ? entry.secondary_keys : []).entries()) push('character_book.entries[' + index + '].secondary_keys[' + keyIndex + ']', key);
        }
        for (const [index, script] of (data.extensions?.regex_scripts ?? []).entries()) {
            push('extensions.regex_scripts[' + index + '].scriptName', script?.scriptName);
        }
        for (const [index, script] of (data.extensions?.tavern_helper?.scripts ?? []).entries()) {
            const base = 'extensions.tavern_helper.scripts[' + index + ']';
            push(base + '.name', script?.name);
            push(base + '.info', script?.info);
            push(base + '.button.buttons[0].name', script?.button?.buttons?.[0]?.name);
            push(base + '.data.title', script?.data?.title);
            push(base + '.data.script_button_name', script?.data?.script_button_name);
        }
        return fields;
    }
    for (const [index, prompt] of (parsed.prompts ?? []).entries()) {
        push('prompts[' + index + '].name', prompt?.name);
    }
    for (const [index, script] of (parsed.extensions?.regex_scripts ?? []).entries()) {
        push('extensions.regex_scripts[' + index + '].scriptName', script?.scriptName);
    }
    for (const [index, script] of (parsed.extensions?.tavern_helper?.scripts ?? []).entries()) {
        const base = 'extensions.tavern_helper.scripts[' + index + ']';
        push(base + '.name', script?.name);
        push(base + '.info', script?.info);
        push(base + '.button.buttons[0].name', script?.button?.buttons?.[0]?.name);
        push(base + '.data.title', script?.data?.title);
        push(base + '.data.script_button_name', script?.data?.script_button_name);
    }
    return fields;
}

// A CARD IS A PNG, so its text is inside base64 chunks. The scanner reads those chunks ITSELF rather than
// asking the caller to extract them: a scanner that trusts its caller can be fed a document the card does
// not contain, and the card's own bytes would then never be scanned.
export function cardTexts(buffer) {
    const texts = [];
    if (buffer.length <= 8 || buffer.readUInt32BE(0) !== 0x89504e47) return texts;
    let offset = 8;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (dataStart + length > buffer.length) break;
        if (type === 'tEXt') {
            const data = buffer.subarray(dataStart, dataStart + length);
            const zero = data.indexOf(0);
            if (zero >= 0) {
                const keyword = data.toString('latin1', 0, zero);
                if (/^(chara|ccv3)$/i.test(keyword)) {
                    texts.push({ keyword, json: Buffer.from(data.subarray(zero + 1).toString('latin1'), 'base64').toString('utf8') });
                }
            }
        }
        offset = dataStart + length + 4;
        if (type === 'IEND') break;
    }
    return texts;
}

// MANIFEST-DECLARED EXEMPTIONS, by field path AND exact value: data in a diff, never a pattern. The value that
// forced it is preset A's two six-byte names, too short for any tier and a generic directive carrying no name,
// handle, platform or credit.
function readDeclared(argv) {
    const index = argv.indexOf('--allow-declared');
    if (index < 0) return [];
    const manifestPath = argv[index + 1];
    if (!manifestPath || !fs.existsSync(manifestPath)) {
        console.error('REFUSING: --allow-declared needs a manifest that exists, got ' + (manifestPath ?? '(nothing)'));
        process.exit(2);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entries = [];
    for (const preset of [...(manifest.presets ?? []), ...(manifest.cards ?? [])]) {
        for (const entry of preset.replaced?.declaredVerbatim ?? preset.declaredVerbatim ?? []) entries.push(entry);
    }
    return entries;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--classes')) {
        console.log(JSON.stringify({
            watermarkClasses: CLASSES.map(([name, pattern]) => ({ name, pattern: String(pattern) })),
            contentClasses: CONTENT_CLASSES.map(([name, pattern]) => ({ name, pattern: String(pattern) })),
            contentClassNote: 'Refused by TOKEN, not by semantic judgement: a fixture carrying one of these tokens is not derived. The list is the whole rule.',
        }, null, 2));
        return;
    }
    // `--marker <value>...`: the identity-marker predicate, asked directly. A reviewer can check "is this value a
    // marker" without constructing a fixture, and the self-test drives the same entry point.
    if (argv.includes('--marker')) {
        const values = argv.slice(argv.indexOf('--marker') + 1);
        if (values.length === 0) {
            console.error('REFUSING: --marker needs at least one value');
            process.exit(2);
        }
        for (const value of values) console.log(JSON.stringify({ value, isMarker: isIdentityMarker(value) }));
        return;
    }

    const DECLARED = readDeclared(argv);
    const files = [];
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--allow-declared') {
            index += 1;
            continue;
        }
        files.push(argv[index]);
    }
    const isDeclared = (pathName, value) => DECLARED.some((entry) => entry.path === normalize(pathName) && entry.value === value);

    let failed = false;

    for (const file of files) {
        const bytes = fs.readFileSync(file);
        const isPng = bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47;
        // THE TEXT A FIXTURE IS SCANNED AS. A preset is scanned as its own bytes; a card is scanned as its
        // LATIN1 bytes AND as the decoded chunk JSON, because its text is base64 and a handle inside base64 is
        // not a match -- while a leak in a chunk's raw bytes must still be caught.
        const texts = isPng ? cardTexts(bytes) : [{ keyword: null, json: bytes.toString('utf8') }];
        if (isPng && texts.length === 0) {
            failed = true;
            console.error('REFUSING: ' + file + ' is a PNG with no chara/ccv3 chunk, so there is no card text to scan');
            continue;
        }
        // THE RAW PASS BELONGS TO CARDS. A preset is a UTF-8 document and is scanned ONCE, as UTF-8 (`texts[0]`)
        // -- scanning its latin1 view as well was a regression introduced with the windowing: latin1 renders every
        // CJK character as three mojibake bytes, the 64+ character rule then sees runs that are not strings, and
        // two fixtures that had passed since they were committed were refused for prose the derivation had
        // already replaced (measured: preset-a 4 findings, preset-b 9, baseline 0). A card's raw bytes DO need
        // their own pass, because a leak can sit in a chunk keyword or in a non-card chunk without being valid
        // UTF-8 at all.
        const scan = { ok: true, findings: [] };
        if (isPng) {
            // BOUNDED WINDOWS, never one 18.5 MB string: the e-mail pattern was quadratic on base64 and wedged
            // the generator, so the cost is kept linear here even though the pattern is now bounded too.
            const rawWindows = [];
            const WINDOW_BYTES = 256 * 1024;
            for (let offset = 0; offset < bytes.length; offset += WINDOW_BYTES) {
                rawWindows.push(bytes.toString('latin1', offset, Math.min(bytes.length, offset + WINDOW_BYTES)));
            }
            Object.assign(scan, scanText(rawWindows.join('\n'), { file }));
        }
        for (const entry of texts) {
            const chunkScan = scanText(entry.json, { file: entry.keyword ? `${file} [${entry.keyword}]` : file });
            scan.findings.push(...chunkScan.findings);
            scan.ok = scan.ok && chunkScan.ok;
        }
        if (!scan.ok) failed = true;
        for (const finding of scan.findings) console.error('REFUSING: ' + finding);

        if (!isPng) {
            let parsed = null;
            try {
                parsed = JSON.parse(bytes.toString('utf8'));
            } catch {
                parsed = null;
            }
            if (!parsed) continue;
            const leaked = nameFields(parsed, false).filter(([pathName, value]) => !isMarkerPrefixed(value) && !isMarkerOnly(value) && !isDeclared(pathName, value));
            if (leaked.length > 0) {
                failed = true;
                const sample = leaked.slice(0, 3).map(([field, value]) => field + '=' + JSON.stringify(value.slice(0, 40))).join(', ');
                console.error('REFUSING: ' + file + ' carries ' + leaked.length + ' name field(s) with no marker prefix: ' + sample);
            }
            continue;
        }

        // AND THE CARD'S NAME FIELDS, from the decoded chunk rather than from the base64.
        for (const entry of texts) {
            let parsed = null;
            try {
                parsed = JSON.parse(entry.json);
            } catch {
                failed = true;
                console.error('REFUSING: ' + file + ' [' + entry.keyword + '] is not JSON, so its name fields cannot be checked');
                continue;
            }
            const leaked = nameFields(parsed, true).filter(([pathName, value]) => !isMarkerPrefixed(value) && !isMarkerOnly(value) && !isDeclared(pathName, value));
            if (leaked.length > 0) {
                failed = true;
                const sample = leaked.slice(0, 3).map(([field, value]) => field + '=' + JSON.stringify(value.slice(0, 40))).join(', ');
                console.error('REFUSING: ' + file + ' [' + entry.keyword + '] carries ' + leaked.length + ' name field(s) with no marker prefix: ' + sample);
            }
        }
    }

    // THE EXEMPTION CANNOT WIDEN: every declared entry must still be present, at that exact path, with that exact
    // value. A manifest describing an exemption nobody uses has drifted, and an edited fixture must not inherit one.
    for (const entry of DECLARED) {
        const key = entry.path.split('.').pop();
        const escaped = entry.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp('"' + key + '"\\s*:\\s*"' + escaped + '"');
        const present = files.some((file) => {
            const bytes = fs.readFileSync(file);
            const isPng = bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47;
            const haystack = isPng ? cardTexts(bytes).map(text => text.json).join('\n') : bytes.toString('utf8');
            return pattern.test(haystack);
        });
        if (!present) {
            failed = true;
            console.error('REFUSING: the manifest declares ' + entry.path + ' = ' + JSON.stringify(entry.value) + ' and no fixture carries it there');
        }
    }

    if (failed) process.exit(2);
    console.log('ok: ' + files.length + ' fixture(s) carry no watermark class, no content class and no unmarked long string or name');
}

// A MODULE GUARD, because the generator imports `scanText`: the CLI must run only when this file is the
// program. Importing it must not scan an empty file list and exit the generator.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-fixture-watermarks.mjs')) main();
