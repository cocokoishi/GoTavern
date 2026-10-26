#!/usr/bin/env node
// REFUSE TO SHIP A FIXTURE THAT CARRIES A WATERMARK.
//
// The user's own instruction, recorded because it is a product constraint rather than a preference:
// "does the committed fixture contain hidden watermarks -- for example my Discord account?"
//
// tools/build-real-fixtures.mjs replaces prose, script bodies and (since its name pass) every name-bearing
// field. This tool checks what SURVIVES: handles, URLs, credits, unsubstituted long strings, and any name field
// that did not receive a marker. Classes are matched case-SENSITIVELY per class, because an insensitive '@'
// matches SillyTavern's own '@api/users' and an insensitive '/Users/' matches GET /api/users/me -- a sweep that
// turns into a phantom defect (AGENTS.md 18's lesson, applied to a leak scan).
//
// Usage:
//   node tools/check-fixture-watermarks.mjs <file> [<file> ...]
//   node tools/check-fixture-watermarks.mjs --allow-declared <manifest.json> <file> ...
//
// Exit 2 names the file, the class and the offending text.

import fs from 'node:fs';

const CLASSES = [
    ['a URL', /https?:\/\/[^\s"'\\]+/],
    ['a Discord handle or invite', /discord(?:app)?\.(?:gg|com)|discord/i],
    ['an e-mail address', /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
    ['a QQ group or handle', /qq\.com|QQ群|群号|加群/],
    ['a support/creator platform', /bilibili|patreon|afdian|爱发电|米游社|kofi|ko-fi/i],
    ['a creator credit', /作者|署名|制作人|汉化|转载|禁止转载|侵删/],
    ['a chat handle', /微信|VX号|vx号/],
];

// MARKER TIERS. MARK_NNNNNN is eleven bytes where a field has room; MNNNNNN is seven and is the short form. A
// SIX-byte tier was measured and refused: Mk0001 is exactly the shape of a two-character CJK name such as the
// six-byte directive in preset A, so a real name could satisfy the gate.
const MARKER_FORMS = [/MARK_\d{6}/, /M\d{6}/];
// Filler characters a name may be padded with after the marker: the generator uses 'x' and the CJK test char.
const FILLER_TAIL = /^[x测]*$/;

const isMarkerPrefixed = (value) => MARKER_FORMS.some((form) => {
    const match = new RegExp('^' + form.source).exec(value);
    if (!match) return false;
    return FILLER_TAIL.test(value.slice(match[0].length));
});
const isMarkerOnly = (value) => MARKER_FORMS.some((form) => new RegExp('^' + form.source + '$').test(value));
const normalize = (pathName) => pathName.replace(/\[(\d+)\]/g, function (match, index) { return '.' + index; });

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
    for (const preset of manifest.presets ?? []) {
        for (const entry of preset.replaced?.declaredVerbatim ?? preset.declaredVerbatim ?? []) entries.push(entry);
    }
    return entries;
}

const argv = process.argv.slice(2);
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
    const text = fs.readFileSync(file, 'utf8');

    for (const [name, pattern] of CLASSES) {
        const match = pattern.exec(text);
        if (match) {
            failed = true;
            console.error('REFUSING: ' + file + ' carries ' + name + ': ' + JSON.stringify(match[0].slice(0, 120)));
        }
    }

    const longStrings = [...text.matchAll(/"([^"\\]{64,})"/g)].map((entry) => entry[1]);
    const unmarked = longStrings.filter((value) => !MARKER_FORMS.some((form) => form.test(value)));
    if (unmarked.length > 0) {
        failed = true;
        console.error('REFUSING: ' + file + ' has ' + unmarked.length + ' string(s) of 64+ characters with no marker, so a substitution did not run: ' + JSON.stringify(unmarked[0].slice(0, 120)));
    }

    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = null;
    }
    if (!parsed) continue;

    const fields = [];
    for (const [index, prompt] of (parsed.prompts ?? []).entries()) {
        if (typeof prompt?.name === 'string') fields.push(['prompts[' + index + '].name', prompt.name]);
    }
    for (const [index, script] of (parsed.extensions?.regex_scripts ?? []).entries()) {
        if (typeof script?.scriptName === 'string') fields.push(['extensions.regex_scripts[' + index + '].scriptName', script.scriptName]);
    }
    for (const [index, script] of (parsed.extensions?.tavern_helper?.scripts ?? []).entries()) {
        const base = 'extensions.tavern_helper.scripts[' + index + ']';
        if (typeof script?.name === 'string') fields.push([base + '.name', script.name]);
        if (typeof script?.info === 'string' && script.info.length > 0) fields.push([base + '.info', script.info]);
        if (typeof script?.button?.buttons?.[0]?.name === 'string') fields.push([base + '.button.buttons[0].name', script.button.buttons[0].name]);
        if (typeof script?.data?.title === 'string') fields.push([base + '.data.title', script.data.title]);
        if (typeof script?.data?.script_button_name === 'string') fields.push([base + '.data.script_button_name', script.data.script_button_name]);
    }

    const leaked = fields.filter(([pathName, value]) => !isMarkerPrefixed(value) && !isMarkerOnly(value) && !isDeclared(pathName, value));
    if (leaked.length > 0) {
        failed = true;
        const sample = leaked.slice(0, 3).map(([field, value]) => field + '=' + JSON.stringify(value.slice(0, 40))).join(', ');
        console.error('REFUSING: ' + file + ' carries ' + leaked.length + ' name field(s) with no marker prefix: ' + sample);
    }
}

// THE EXEMPTION CANNOT WIDEN: every declared entry must still be present, at that exact path, with that exact
// value. A manifest describing an exemption nobody uses has drifted, and an edited fixture must not inherit one.
for (const entry of DECLARED) {
    const key = entry.path.split('.').pop();
    const escaped = entry.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('"' + key + '"\\s*:\\s*"' + escaped + '"');
    const present = files.some((file) => pattern.test(fs.readFileSync(file, 'utf8')));
    if (!present) {
        failed = true;
        console.error('REFUSING: the manifest declares ' + entry.path + ' = ' + JSON.stringify(entry.value) + ' and no fixture carries it there');
    }
}

if (failed) process.exit(2);
console.log('ok: ' + files.length + ' fixture(s) carry no watermark class and no unmarked long string or name');