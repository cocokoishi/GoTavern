// BROWSER CREATE -> READ-BACK for the characters domain (Beta lane G2, gap row 4).
//
// WHAT IT ANSWERS, in one sentence: if a user opens the NEW CHARACTER panel in the unmodified pinned frontend, types a
// name/description/first message and presses Create, does the product store a card whose bytes can be read back through
// the product's own export route (which decodes the STORED PNG), and do the stored fields equal what the user typed?
//
// WHY IT IS A BROWSER JOURNEY AND NOT A ROUTE TEST. The existing route-level import/write oracles prove the handlers;
// they do not prove that the shipped frontend's create panel reaches `/api/characters/create` with the fields a user
// typed. This probe drives the real controls (`#rm_button_create`, `#form_create`, `#character_name_pole`,
// `#description_textarea`, `#firstmessage_textarea`) and reads the result back through `/api/characters/export?format=json`
// — a route that RE-DECODES the stored PNG card — so a card that renders but is not persisted cannot pass.
//
// TEETH (`--self-test`): after the green read-back, the STORED card's `description` field is tampered with in place and
// the same read-back must report the tampered value and refuse the expectation. That proves the read-back is reading
// the stored bytes rather than echoing the page's in-memory state. The original bytes are restored afterwards.
//
// WHAT IT DOES NOT PROVE: pinned-vs-GoTavern equality (data-domain-drive.mjs owns that comparison and its committed
// fixture already records this interaction on both legs), extension-driven creation, card avatars from a file picker,
// or a real provider. Headless only; the server is booted with --browserLaunchEnabled false.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootSubject, freePort, waitForServer } from './q20-leg-runtime.mjs';
import { openPage, readReadiness } from './q20-persistence-drive.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';

const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..', '..');

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

const dataRoot = path.resolve(argumentValue('--data-root') ?? '');
const reportPath = argumentValue('--report', path.join(repositoryRoot, 'tests', 'browser', 'character-create-probe.json'));
const selfTest = process.argv.includes('--self-test');
if (!dataRoot) {
    console.error('usage: node character-create-probe.mjs --data-root <empty data root> [--report <path>] [--self-test]');
    process.exit(2);
}

const NAME = 'Probe Created';
const DESCRIPTION = 'probe created description';
const FIRST_MESSAGE = 'probe first message';
const PERSONALITY = 'probe personality';
const MES_EXAMPLE = 'probe example {{char}}: hello';

const report = {
    surface: 'character-create',
    subject: 'gotavern',
    recordedAt: new Date().toISOString(),
    host: 'local-layer-a',
    inputs: { name: NAME, description: DESCRIPTION, firstMessage: FIRST_MESSAGE, personality: PERSONALITY, mesExample: MES_EXAMPLE },
    steps: [],
    browser: {},
    disk: {},
    teeth: null,
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

// The stored card is a PNG whose `chara` tEXt chunk is base64 JSON. Reading it here is the BYTES check; the product
// read-back below is the route check, and both must agree on the same field.
function decodePngChara(bytes) {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) return null;
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 'tEXt') {
            const zero = data.indexOf(0);
            if (zero >= 0 && data.toString('latin1', 0, zero).toLowerCase() === 'chara') {
                try {
                    return JSON.parse(Buffer.from(data.toString('latin1', zero + 1), 'base64').toString('utf8'));
                } catch {
                    return null;
                }
            }
        }
        if (type === 'IEND') break;
        offset += 12 + length;
    }
    return null;
}

// The product's own read-back of the STORED card: /api/characters/export?format=json re-reads the PNG's text chunk,
// converts to v2 and strips private fields, so anything it returns came from the file on disk.
async function readBackThroughProduct(page, avatar) {
    return page.evaluate(async avatarName => {
        const script = await import('./script.js');
        const response = await fetch('/api/characters/export', {
            method: 'POST',
            headers: script.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatarName, format: 'json' }),
        });
        const text = await response.text();
        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }
        return { status: response.status, card: parsed };
    }, avatar);
}

// The read-back expectation, in one place so the teeth mutation uses the same predicate the green run used.
function readBackMatches(card, expected) {
    if (card === null) return { ok: false, reason: 'no card parsed' };
    const data = card.data && typeof card.data === 'object' ? card.data : card;
    const checks = {
        name: data?.name === expected.name,
        description: data?.description === expected.description,
        firstMes: data?.first_mes === expected.firstMessage,
        personality: data?.personality === expected.personality,
        mesExample: data?.mes_example === expected.mesExample,
    };
    return { ok: Object.values(checks).every(Boolean), checks, observed: {
        name: data?.name ?? null,
        description: data?.description ?? null,
        firstMes: data?.first_mes ?? null,
        personality: data?.personality ?? null,
        mesExample: data?.mes_example ?? null,
    } };
}

let browser = null;
let server = null;
try {
    await fs.mkdir(dataRoot, { recursive: true });
    report.config = await seedLegConfig(dataRoot);
    const port = await freePort();
    const boot = await bootSubject({ argv: process.argv.slice(2), dataRoot, port, external: Boolean(process.env.PROBE_BASE_URL) });
    server = boot.server ?? null;
    if (boot.bootRefusal) throw new Error(`subject could not be booted: ${boot.bootRefusal}`);
    report.server = { external: boot.external, pid: boot.external ? Number(process.env.PROBE_SERVER_PID ?? 0) || null : (boot.server?.pid ?? null) };
    await waitForServer(`${boot.baseURL}/version`, 120000);
    report.server.version = await (await fetch(`${boot.baseURL}/version`)).json().catch(() => null);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await openPage(page, boot.baseURL);
    const readiness = await readReadiness(page);
    report.browser.readiness = readiness;
    step('page-loaded', readiness?.settingsReady === true, JSON.stringify(readiness));

    const created = await page.evaluate(async inputs => {
        const script = await import('./script.js');
        const open = document.querySelector('#rm_button_create');
        if (!open) return { ok: false, reason: 'no #rm_button_create control' };
        open.click();
        await new Promise(resolve => setTimeout(resolve, 400));
        const form = document.querySelector('#form_create');
        const nameField = document.querySelector('#character_name_pole');
        if (!form || !nameField) return { ok: false, reason: 'the create panel did not produce #form_create/#character_name_pole' };
        const fill = (selector, value) => {
            const field = document.querySelector(selector);
            if (!field) return false;
            field.value = value;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        };
        fill('#character_name_pole', inputs.name);
        fill('#description_textarea', inputs.description);
        fill('#firstmessage_textarea', inputs.firstMessage);
        fill('#personality_textarea', inputs.personality);
        fill('#mes_example_textarea', inputs.mesExample);
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        const deadline = performance.now() + 20000;
        while (performance.now() < deadline) {
            await script.getCharacters();
            const match = (script.characters ?? []).find(entry => entry?.name === inputs.name);
            if (match) return { ok: true, avatar: match.avatar ?? null, name: match.name ?? null };
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, reason: 'the created character never appeared in the frontend list' };
    }, { name: NAME, description: DESCRIPTION, firstMessage: FIRST_MESSAGE, personality: PERSONALITY, mesExample: MES_EXAMPLE });
    report.browser.created = created;
    step('created-through-the-create-panel', created?.ok === true && typeof created.avatar === 'string' && created.avatar.length > 0, JSON.stringify(created));
    if (!created?.ok) throw new Error('create step failed');

    const cardPath = path.join(dataRoot, 'default-user', 'characters', created.avatar);
    const storedBytes = await fs.readFile(cardPath);
    const storedChara = decodePngChara(storedBytes);
    report.disk = {
        file: `characters/${created.avatar}`,
        bytes: storedBytes.length,
        sha256: createHash('sha256').update(storedBytes).digest('hex'),
        charaDecoded: storedChara !== null,
        chara: storedChara === null ? null : {
            name: storedChara?.data?.name ?? storedChara?.name ?? null,
            description: storedChara?.data?.description ?? storedChara?.description ?? null,
            firstMes: storedChara?.data?.first_mes ?? storedChara?.first_mes ?? null,
        },
    };
    step('stored-png-carries-the-typed-card',
        storedChara !== null
        && (storedChara?.data?.name ?? storedChara?.name) === NAME
        && (storedChara?.data?.description ?? storedChara?.description) === DESCRIPTION,
        JSON.stringify(report.disk));

    const readBack = await readBackThroughProduct(page, created.avatar);
    const verdict = readBackMatches(readBack.card, { name: NAME, description: DESCRIPTION, firstMessage: FIRST_MESSAGE, personality: PERSONALITY, mesExample: MES_EXAMPLE });
    report.browser.readBack = { status: readBack.status, verdict };
    step('read-back-through-the-product-matches-what-was-typed', readBack.status === 200 && verdict.ok === true, JSON.stringify(verdict));

    if (selfTest) {
        // TEETH: tamper with the STORED field through a file copy, then the same read-back must observe the tampering.
        const original = await fs.readFile(cardPath);
        try {
            const tampered = JSON.parse(JSON.stringify(storedChara));
            if (tampered.data && typeof tampered.data === 'object') tampered.data.description = 'TAMPERED-BY-PROBE';
            else tampered.description = 'TAMPERED-BY-PROBE';
            // BOTH card text carriers are rewritten: the stored PNG carries `chara` and `ccv3`, and the product's
            // read() prefers `ccv3`. Tampering only `chara` would read the untouched `ccv3` and prove nothing.
            const mutated = replaceCardTextChunks(storedBytes, JSON.stringify(tampered));
            await fs.writeFile(cardPath, mutated);
            // THE PRODUCT CACHES THE CARD, so the mutated bytes are read by a SECOND process over the SAME tree. That
            // is also the stronger claim: a restart re-reads the file rather than echoing the page's memory.
            const teethPort = await freePort();
            const teethBoot = await bootSubject({ argv: process.argv.slice(2), dataRoot, port: teethPort, external: Boolean(process.env.PROBE_BASE_URL) });
            const teethServer = teethBoot.server ?? null;
            let tamperedReadBack;
            try {
                await waitForServer(`${teethBoot.baseURL}/version`, 120000);
                const teethPage = await browser.newPage();
                await openPage(teethPage, teethBoot.baseURL);
                await readReadiness(teethPage);
                tamperedReadBack = await readBackThroughProduct(teethPage, created.avatar);
                await teethPage.close();
            } finally {
                if (teethServer) teethServer.kill();
            }
            const tamperedVerdict = readBackMatches(tamperedReadBack.card, { name: NAME, description: DESCRIPTION, firstMessage: FIRST_MESSAGE, personality: PERSONALITY, mesExample: MES_EXAMPLE });
            report.teeth = {
                mutatedField: 'data.description',
                readBackStatus: tamperedReadBack.status,
                observedDescription: tamperedVerdict.observed?.description ?? null,
                matchesExpectation: tamperedVerdict.ok,
                caught: tamperedVerdict.ok === false && tamperedVerdict.observed?.description === 'TAMPERED-BY-PROBE',
            };
            step('mutating-the-stored-field-turns-the-read-back-red', report.teeth.caught === true, JSON.stringify(report.teeth));
        } finally {
            await fs.writeFile(cardPath, original);
        }
    }
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}
if (report.failure) process.exitCode = 1;

// replaceCardTextChunks rewrites the base64 payload of every card text carrier (`chara`, `ccv3`) in a stored PNG.
function replaceCardTextChunks(bytes, json) {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (!bytes.subarray(0, 8).equals(signature)) throw new Error('stored card is not a PNG');
    const encoded = Buffer.from(json, "utf8").toString("base64");
    const chunks = [bytes.subarray(0, 8)];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString("latin1", offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === "tEXt") {
            const zero = data.indexOf(0);
            const keyword = zero >= 0 ? data.toString("latin1", 0, zero).toLowerCase() : "";
            if (keyword === "chara" || keyword === "ccv3") {
                chunks.push(buildTextChunk(Buffer.concat([data.subarray(0, zero + 1), Buffer.from(encoded, "latin1")])));
                offset += 12 + length;
                continue;
            }
        }
        chunks.push(bytes.subarray(offset, offset + 12 + length));
        offset += 12 + length;
    }
    return Buffer.concat(chunks);
}


// ---- PNG chunk helpers for the stored-card bytes check ---------------------

function findChunkLengthOffset(bytes, markerIndex) {
    // Walk the chunk list from the signature so the returned offset is a chunk LENGTH field, not the marker's index.
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const chunkEnd = offset + 12 + length;
        if (markerIndex >= offset && markerIndex < chunkEnd) return offset;
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        if (type === 'IEND') break;
        offset = chunkEnd;
    }
    throw new Error('tEXt chunk enclosing the chara marker was not found');
}

var crcTableCache = null;
function crcTable() {
    if (crcTableCache) return crcTableCache;
    const table = new Int32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value;
    }
    crcTableCache = table;
    return table;
}

function crc32(buffer) {
    const table = crcTable();
    let crc = 0 ^ -1;
    for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xFF];
    return (crc ^ -1) >>> 0;
}

function buildTextChunk(data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}
