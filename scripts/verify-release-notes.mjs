#!/usr/bin/env node
// Validate a curated release-notes body before it is published. Fails closed.
//
// Usage:
//   node scripts/verify-release-notes.mjs <notes-file> <tag> [--checksums <checksums.txt>]
//
// The release workflow calls this on BOTH channels, for the curated body only. The rules (and why each exists) are in
// scripts/release-governance/notes.mjs; the teeth are in scripts/release-governance.test.mjs.

import { readFileSync, existsSync } from 'node:fs';
import { validateReleaseNotes } from './release-governance/notes.mjs';

const args = process.argv.slice(2);
const positional = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--checksums');
const notesPath = positional[0];
const tag = positional[1];
const checksumsIndex = args.indexOf('--checksums');
const checksumsPath = checksumsIndex === -1 ? null : args[checksumsIndex + 1] ?? null;

function fail(message) {
    console.error(`::error::${message}`);
    process.exit(1);
}

if (!notesPath || !tag) fail('usage: verify-release-notes.mjs <notes-file> <tag> [--checksums <checksums.txt>]');
if (!existsSync(notesPath)) fail(`release notes file ${notesPath} does not exist`);
if (checksumsPath !== null && !existsSync(checksumsPath)) fail(`checksums file ${checksumsPath} does not exist`);

const text = readFileSync(notesPath, 'utf8');
const checksumsText = checksumsPath === null ? null : readFileSync(checksumsPath, 'utf8');
const verdict = validateReleaseNotes({ text, tag, checksumsText });

if (verdict.ok) {
    console.log(`release notes OK: ${notesPath} names ${tag}, ${Buffer.byteLength(text, 'utf8')} bytes`);
    for (const observation of verdict.observations) console.log(`  note: ${observation}`);
    process.exit(0);
}
console.error(`::error::release notes ${notesPath} are not publishable:`);
for (const problem of verdict.problems) console.error(`  - ${problem}`);
process.exit(1);
