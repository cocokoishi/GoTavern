#!/usr/bin/env node
// REFUSE TO SHIP A FIXTURE THAT CARRIES A WATERMARK.
//
// The user's own instruction, recorded because it is a product constraint rather than a preference:
// "does the committed fixture contain hidden watermarks -- for example my Discord account?"
//
// Prose and script bodies are replaced by tools/build-real-fixtures.mjs. This checks what SURVIVES: names,
// ids, regex sources, script info, and anything a substitution forgot. It is deliberately case-sensitive per
// class, because a case-insensitive '@' matches SillyTavern's own '@api/users' path and a case-insensitive
// '/Users/' matches GET /api/users/me -- a sweep that turns into a phantom defect (AGENTS.md rule 18's
// lesson, applied to a leak scan).
//
// Usage: node tools/check-fixture-watermarks.mjs <file> [<file> ...]
// Exits 2 and names the file, the class and the matching text when anything matches.

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

let failed = false;
for (const file of process.argv.slice(2)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [name, pattern] of CLASSES) {
        const match = pattern.exec(text);
        if (match) {
            failed = true;
            console.error(`REFUSING: ${file} carries ${name}: ${JSON.stringify(match[0].slice(0, 120))}`);
        }
    }
    // A marker is the only thing allowed to stand where prose or a NAME used to be, and there are three tiers
    // because a real preset's prompt names can be six bytes long ("勿动" is exactly that) and cannot hold the
    // full form. Teaching the scanner the compact tiers is what lets the generator emit them: a scanner that
    // accepts only MARK_ would silently pass an unsubstituted short name, which is the leak it exists for.
    // THE TIERS. `MARK_NNNNNN` (eleven bytes) for prose and long names; `MNNNNNN` (seven) for names too
    // short for it. A six-byte form was tried first and rejected: `Mk0001` is exactly the size of a
    // two-character CJK name such as 勿动, so a real name could satisfy the gate. Seven bytes is one more
    // than a six-byte name can occupy, and the probe measured exactly one such name in preset A.
    const MARKER_FORMS = [/MARK_\d{6}/, /M\d{6}/];
    const hasMarker = value => MARKER_FORMS.some(form => form.test(value));
    const longStrings = [...text.matchAll(/"([^"\\]{64,})"/g)].map(entry => entry[1]);
    const unmarked = longStrings.filter(value => !hasMarker(value));
    if (unmarked.length > 0) {
        failed = true;
        console.error(`REFUSING: ${file} has ${unmarked.length} string(s) of 64+ characters with no marker (MARK_NNNNNN or MNNNNNN), so a substitution did not run: ${JSON.stringify(unmarked[0].slice(0, 120))}`);
    }
    // THE NAMES ARE SHORT ENOUGH TO HIDE IN, so the tier forms are checked where they are supposed to be used:
    // every prompt name, regex script name and helper script name must BE a marker, not merely contain one.
    let names = null;
    try {
        names = JSON.parse(text);
    } catch {
        names = null;
    }
    if (names) {
        const nameFields = [];
        for (const [index, prompt] of (names.prompts ?? []).entries()) {
            if (typeof prompt?.name === 'string') nameFields.push([`prompts[${index}].name`, prompt.name]);
        }
        for (const [index, script] of (names.extensions?.regex_scripts ?? []).entries()) {
            if (typeof script?.scriptName === 'string') nameFields.push([`extensions.regex_scripts[${index}].scriptName`, script.scriptName]);
        }
        for (const [index, script] of (names.extensions?.tavern_helper?.scripts ?? []).entries()) {
            if (typeof script?.name === 'string') nameFields.push([`extensions.tavern_helper.scripts[${index}].name`, script.name]);
            if (typeof script?.info === 'string' && script.info.length > 0) nameFields.push([`extensions.tavern_helper.scripts[${index}].info`, script.info]);
        }
        // THE SAME THREE FORMS AS hasMarker, built from the SAME list: the first version of this line spelled the
        // pattern out separately and accepted `Mk0001` (four DIGITS) while the generator can only emit `Mk\d{4}`
        // with five characters after the prefix. Two spellings of one rule is a gate that disagrees with itself.
        const leaked = nameFields.filter(([, value]) => !MARKER_FORMS.some(form => new RegExp(`^${form.source}$`).test(value)));
        if (leaked.length > 0) {
            failed = true;
            console.error(`REFUSING: ${file} carries ${leaked.length} substituted-field-that-is-not-a-marker name field(s) that are not markers: ${leaked.slice(0, 3).map(([field, value]) => `${field}=${JSON.stringify(value.slice(0, 40))}`).join(', ')}`);
        }
    }
}
if (failed) process.exit(2);
console.log(`ok: ${process.argv.length - 2} fixture(s) carry no watermark class and no unmarked long string`);
