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
    // A marker is the only thing allowed to stand where prose or a name used to be: a long run of filler with
    // no marker means a substitution step was skipped, and that is the failure mode this whole file exists for.
    const longStrings = [...text.matchAll(/"([^"\\]{64,})"/g)].map(entry => entry[1]);
    const unmarked = longStrings.filter(value => !/MARK_\d{6}/.test(value));
    if (unmarked.length > 0) {
        failed = true;
        console.error(`REFUSING: ${file} has ${unmarked.length} string(s) of 64+ characters with no MARK_ marker, so a substitution did not run: ${JSON.stringify(unmarked[0].slice(0, 120))}`);
    }
}
if (failed) process.exit(2);
console.log(`ok: ${process.argv.length - 2} fixture(s) carry no watermark class and no unmarked long string`);