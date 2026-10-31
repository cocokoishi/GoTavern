#!/usr/bin/env node
// DOES THE LONG-LIVED JUDGE HAVE TEETH? Proven on THIS run's own artefacts, not on a hand-written example.
//
// WHY. A comparator that returns "match" for two reports it never really compared is the exact false green the
// differential doctrine exists to forbid. This program takes the four leg reports a green run just produced, mutates
// each of the facts the comparator claims to check, and requires the NAMED check to go red on top of the green
// baseline. It needs no browser and no server, so it costs a fraction of a second after the drives are paid for --
// and running it against the same artefacts the judge judged is the only way the baseline is the pair the run
// actually produced.
//
// USAGE:
//   node tests/browser/longlived-gate-selftest.mjs \
//     --drive-go build/longlived-drive-gotavern.json --drive-pinned build/longlived-drive-pinned.json \
//     --restart-go build/longlived-restart-gotavern.json --restart-pinned build/longlived-restart-pinned.json \
//     --out build/longlived-teeth.json
//
// Exit 0 only when the baseline is green AND every mutation produced its named red.

import fs from 'node:fs/promises';
import path from 'node:path';

import { compareLegs } from './longlived-compare-legs.mjs';

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

async function readLeg(target) {
    if (!target) return null;
    const body = await fs.readFile(target, 'utf8');
    return { label: path.basename(target), path: target, leg: JSON.parse(body) };
}

const clone = value => structuredClone(value);

/**
 * The mutations. Each names the check it must turn red and the verdict it must produce.
 *
 * They are all facts this qualification claims to compare, so a survivor is a finding about the JUDGE: either the
 * assertion cannot fail, or the artefact does not carry the fact it claims to.
 */
export const MUTATIONS = [
    {
        name: 'provider-body-byte',
        expectedCheck: 'drive-provider-request-1-bytes',
        expectedVerdicts: ['mismatch'],
        apply: legs => {
            const request = legs.driveGo.leg.provider.requests.find(entry => /chat\/completions/.test(entry.path ?? ''));
            request.body = `${request.body} `;
            request.byteLength = Buffer.byteLength(request.body, 'utf8');
            request.sha256 = 'mutation-sha256';
        },
    },
    {
        name: 'provider-request-count',
        expectedCheck: 'drive-provider-request-count',
        expectedVerdicts: ['mismatch'],
        apply: legs => {
            const first = legs.driveGo.leg.provider.requests.find(entry => /chat\/completions/.test(entry.path ?? ''));
            legs.driveGo.leg.provider.requests.push({ ...clone(first), body: `${first.body}EXTRA`, byteLength: first.byteLength + 5 });
        },
    },
    {
        name: 'roster-name',
        expectedCheck: 'roster-equal',
        expectedVerdicts: ['mismatch'],
        apply: legs => { legs.driveGo.leg.browser.roster.names = [...legs.driveGo.leg.browser.roster.names, 'Intruder Card']; },
    },
    {
        name: 'resumed-chat-length',
        expectedCheck: 'resumed-chat-length',
        expectedVerdicts: ['mismatch'],
        apply: legs => { legs.driveGo.leg.browser.baseline.chatLength += 1; },
    },
    {
        name: 'preset-switch',
        expectedCheck: 'preset-switch-applied',
        expectedVerdicts: ['mismatch'],
        apply: legs => { legs.driveGo.leg.browser.presetSwitch.preset = 'Some Other Preset'; },
    },
    {
        name: 'changed-file-set',
        expectedCheck: 'changed-planted-files',
        expectedVerdicts: ['mismatch'],
        apply: legs => { legs.driveGo.leg.disk.changed = legs.driveGo.leg.disk.changed.slice(0, 1); },
    },
    {
        name: 'resumed-chat-message-text',
        expectedCheck: 'resumed-chat-sequence',
        expectedVerdicts: ['mismatch'],
        apply: legs => {
            // The comparator compares THE RESUMED CHAT (the 2026-09-14 file); mutating any other chat would be a
            // mutation of something this gate does not claim to compare.
            const resumed = legs.driveGo.leg.disk.chatsAfter.find(chat => /2026-09-14/.test(chat.file ?? ''))
                ?? legs.driveGo.leg.disk.chatsAfter.find(chat => (chat.messages ?? []).length > 10);
            const target = resumed.messages.findIndex(message => !message.isUser) >= 0
                ? resumed.messages.findIndex(message => !message.isUser) : 1;
            resumed.messages[target].mes = `${resumed.messages[target].mes} MUTATED`;
        },
    },
    {
        name: 'persisted-temperature',
        expectedCheck: 'temperature-persisted',
        expectedVerdicts: ['mismatch'],
        apply: legs => { legs.driveGo.leg.browser.settingsPersisted.temperature = 1.99; },
    },
    {
        name: 'leg-completeness',
        expectedCheck: 'leg-pinned-drive-complete',
        expectedVerdicts: ['harness-error'],
        apply: legs => { legs.drivePinned.leg.steps.push({ name: 'mutation-injected-failure', ok: false, detail: null }); },
    },
    {
        name: 'added-file-set',
        expectedCheck: 'added-files-normalised',
        expectedVerdicts: ['mismatch'],
        apply: legs => { legs.driveGo.leg.disk.added.push({ path: 'default-user/unexpected-mutation.txt', bytes: 4, sha256: 'mutation' }); },
    },
    {
        name: 'restart-process-identity',
        expectedCheck: 'restart-is-a-new-process-go',
        expectedVerdicts: ['not-observed', 'mismatch'],
        apply: legs => { legs.restartGo.leg.server.pid = legs.driveGo.leg.server.pid; },
    },
    {
        name: 'discriminator-missing-from-own-disk',
        expectedCheck: 'discriminator-present-in-own-disk-data',
        expectedVerdicts: ['mismatch'],
        apply: legs => {
            const strip = value => String(value).split(legs.driveGo.leg.replyPrefix).join('');
            for (const chat of legs.driveGo.leg.disk.chatsAfter) {
                for (const message of chat.messages ?? []) {
                    if (Array.isArray(message.swipes)) message.swipes = message.swipes.map(strip);
                }
            }
        },
    },
];

export function runSelftest(legs) {
    const baseline = compareLegs(legs);
    const mutations = [];
    for (const mutation of MUTATIONS) {
        const mutated = clone(legs);
        mutation.apply(mutated);
        const judged = compareLegs(mutated);
        const target = judged.checks.find(check => check.name === mutation.expectedCheck) ?? null;
        const observedVerdict = target?.verdict ?? 'absent';
        const passed = mutation.expectedVerdicts.includes(observedVerdict);
        mutations.push({
            name: mutation.name,
            expectedCheck: mutation.expectedCheck,
            expectedVerdicts: mutation.expectedVerdicts,
            observedVerdict,
            passed,
            detail: passed ? null : target?.detail ?? 'the expected check did not exist or kept its baseline verdict',
        });
    }
    return {
        schema: 'gotavern-longlived-gate-selftest',
        schemaVersion: 1,
        baseline: { ok: baseline.ok, verdict: baseline.verdict, failed: baseline.checks.filter(check => !check.ok).map(check => check.name) },
        mutations,
        summary: {
            mutations: mutations.length,
            killed: mutations.filter(entry => entry.passed).length,
            survived: mutations.filter(entry => !entry.passed).map(entry => entry.name),
        },
        ok: baseline.ok === true && mutations.every(entry => entry.passed === true),
    };
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href.replace(/%20/g, ' ');
if (isMain) {
    const argv = process.argv.slice(2);
    const [driveGo, drivePinned, restartGo, restartPinned] = await Promise.all([
        readLeg(argument('--drive-go', null)),
        readLeg(argument('--drive-pinned', null)),
        readLeg(argument('--restart-go', null)),
        readLeg(argument('--restart-pinned', null)),
    ]);
    if (!driveGo || !drivePinned || !restartGo || !restartPinned) {
        console.error('usage: node longlived-gate-selftest.mjs --drive-go <json> --drive-pinned <json> --restart-go <json> --restart-pinned <json> --out <json>');
        process.exit(2);
    }
    const teeth = runSelftest({ driveGo, drivePinned, restartGo, restartPinned });
    const out = argument('--out', path.join(process.cwd(), 'longlived-teeth.json'));
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await fs.writeFile(path.resolve(out), `${JSON.stringify(teeth, null, 2)}\n`, 'utf8');
    if (!teeth.baseline.ok) console.error(`BASELINE IS NOT GREEN: ${JSON.stringify(teeth.baseline)}`);
    for (const mutation of teeth.mutations) {
        if (!mutation.passed) console.error(`SURVIVED ${mutation.name}: expected ${mutation.expectedCheck} -> ${mutation.expectedVerdicts.join('|')}, observed ${mutation.observedVerdict}: ${JSON.stringify(mutation.detail).slice(0, 500)}`);
    }
    console.error(`long-lived gate teeth: ${teeth.ok ? 'ALL MUTATIONS KILLED' : 'FAILED'} (${teeth.summary.killed}/${teeth.summary.mutations}) -> ${path.resolve(out)}`);
    process.exit(teeth.ok ? 0 : 1);
}
