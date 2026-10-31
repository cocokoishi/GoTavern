#!/usr/bin/env node
// THE ASSET PROBE: load the pinned frontend, look at the pictures.
//
// WHY THIS EXISTS. A user said "avatars do not display, backgrounds are broken" and every gate in this
// repository was green. `tests/browser/extension-tavern-helper-comparison.json` had even RECORDED the
// cause -- `/thumbnail` 404 on GoTavern, 200 on pinned -- and reported `differenceCount: 0`, because a
// `knownReason` said "codec boundary, recorded not asserted", while the same artefact recorded
// GoTavern's two console 404s beside pinned's empty list. Every measurement here was server-side or
// request-side; nothing loaded the page and asked whether an `<img>` decoded (docs/gate-blindspots.md
// §6). This probe is that measurement (GOAL.md §8.4, AGENTS.md 42-46, ARCHITECTURE.md §35.2).
//
// WHAT IT DOES, per leg. Stages a byte-identical user tree (a character card PNG, a background PNG and
// a persona PNG), boots the leg, drives the UNMODIFIED pinned frontend, and records:
//
//   1. every image request the page makes: {url, status, contentType, byteLength};
//   2. DOM state: `complete`, `naturalWidth`, `naturalHeight` and resolved `src` for every avatar in
//      the character list and every chat message avatar; the computed `background-image` of the element
//      that carries the applied background; the background gallery tile and its lazily-loaded
//      thumbnail;
//   3. console messages, page errors and failed requests.
//
// It records OBSERVATIONS and FAITHFULNESS FLAGS. It does not decide whether a leg is right: that is
// compare-asset-legs.mjs, so the subject and the oracle do not share an expectation (AGENTS.md
// differential doctrine 3).
//
// USAGE (see the browser-differential workflow):
//   node tests/browser/asset-probe.mjs --report <leg>.json                       # GoTavern leg
//   node tests/browser/run-against-pinned.mjs asset-probe.mjs -- --report <pinned-leg>.json
//
// The mined selector knowledge below was read from the PINNED source, never guessed:
//   public/script.js  getThumbnailUrl(type, file) -> `/thumbnail?type=…&file=…` (encodeURIComponent)
//   public/script.js  buildAvatarList -> `#${templateId} .avatar` clone, `find('img').attr('src', …)`
//                     character: getThumbnailUrl('avatar', file); persona: getThumbnailUrl('persona', …)
//   public/index.html #inline_avatar_template -> `.avatar > img`
//   public/index.html #message_template -> `.mes > .mesAvatarWrapper > .avatar > img`
//   public/scripts/backgrounds.js:251 `$('#bg1').css('background-image', info.url)`
//   public/scripts/backgrounds.js:160-193 tile clone `#background_template .bg_example`,
//                     `.thumbnail-clipper.lazy-load-background` filled lazily, attrs `bgfile`/`data-url`

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { seedLegConfig } from './seed-leg-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitForServer(url, deadlineMs = 90000) {
    const deadline = Date.now() + deadlineMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.status > 0) return true;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`server never answered ${url}: ${lastError?.message ?? 'no response'}`);
}

// ---------------------------------------------------------------------------------------------
// A DETERMINISTIC PNG CARD BUILDER, reused from tools/probe-characters-read.mjs (same construction,
// same level-0 deflate so the bytes are fixed by the format rather than by the linked zlib).
// The fixture must be byte-identical on both legs or the comparison is between two different trees.
// ---------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0 ^ -1;
    for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF];
    return (crc ^ -1) >>> 0;
}

function pngChunk(name, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(name, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

function textChunk(keyword, text) {
    return pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}

/** A 2x2 RGB PNG carrying the requested tEXt chunks. */
function buildPng(textChunks) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.from([0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12]);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        ...textChunks,
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

const CARD = {
    name: 'Probe Asset Card',
    description: 'PROBE_ASSET_CARD a character whose only job is to have an avatar that must render.',
    personality: 'PROBE_ASSET_CARD',
    scenario: 'PROBE_ASSET_CARD',
    first_mes: 'PROBE_ASSET_GREETING hello',
    mes_example: '',
    creatorcomment: '',
    avatar: 'none',
    chat: 'Probe Asset Card',
    talkativeness: '0.5',
    fav: false,
    tags: [],
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
        name: 'Probe Asset Card',
        description: 'PROBE_ASSET_CARD a character whose only job is to have an avatar that must render.',
        personality: 'PROBE_ASSET_CARD',
        scenario: 'PROBE_ASSET_CARD',
        first_mes: 'PROBE_ASSET_GREETING hello',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: 'gotavern-asset-probe',
        character_version: '1',
        extensions: {},
    },
};

const CARD_FILE = 'Probe Asset Card.png';
const BACKGROUND_FILE = 'probe-asset-background.png';
const PERSONA_FILE = 'probe-asset-persona.png';

// THE REAL CARD'S STRUCTURE, AS A SECOND CHARACTER (GOAL.md §8.4, AGENTS.md 56's "a leg that needs a real
// artifact uses the committed DERIVATION"). The synthetic card above is one greeting and an empty book: it can
// prove an avatar decodes and nothing about a card that HAS structure. The committed derivation
// (`tests/browser/fixtures/real/card-a.png`) carries 490 lorebook entries, 5 alternate greetings, 11 regex
// scripts and a helper script, every one of them desensitised. This probe stages it as a SECOND character so
// the leg exercises the shapes a user's card actually has -- and the swiped-message drive below uses its five
// alternate greetings, which no synthetic card in this repository has.
const REAL_CARD_NAME = 'Real Structure Card';
// RESOLVED FROM `here`, NOT FROM THE PROCESS CWD, and the first version got this wrong in a way only the PINNED
// leg exposed: `run-against-pinned.mjs` spawns the child with `cwd: tests/browser`, so a `../fixtures/...` path
// resolved to `tests/fixtures/real/card-a.png` and BOTH legs died with ENOENT (run 40304309528, step "Record the
// asset legs": `Error: ENOENT: no such file or directory, open '.../tests/fixtures/real/card-a.png'`). `here` is
// the directory of THIS module, which is the same on both legs whatever the child's cwd is.
const REAL_CARD_RELATIVE = path.join(here, 'fixtures', 'real', 'card-a.png');

// THE USER DIRECTORY, READ FROM THE PINNED SOURCE RATHER THAN ASSUMED. Pinned resolves every user-data
// directory as `path.join(DATA_ROOT, handle, template)` (src/users.js `getUserDirectories`) with
// `DEFAULT_USER.handle === 'default-user'` (src/constants.js:54-55), so a card staged at
// `<dataRoot>/characters/` is a card nobody can see. Run 40202318194 measured exactly that: on BOTH legs the
// character list rendered zero rows, the persona thumbnail 404'd, and the chat opened onto the template's
// empty `<img src="">` -- four guards red, identically on both legs, which is a harness-faithfulness
// failure and not a product finding. The handle is recorded in the fixture block so the comparator compares
// the tree the legs actually used.
const USER_HANDLE = 'default-user';

function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

// THE CARD'S OWN STRUCTURE, COUNTED FROM THE PNG THE PROBE STAGED. A fixture that failed to stage, or staged a
// card whose `ccv3` chunk a reader never reaches, would otherwise look identical to a card with no book: the
// probe records what the bytes contain, so the comparator can require the numbers rather than infer them.
function describeCardStructure(bytes) {
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (type === 'tEXt') {
            const data = bytes.subarray(dataStart, dataStart + length);
            const zero = data.indexOf(0);
            if (zero >= 0 && /^ccv3$/i.test(data.toString('latin1', 0, zero))) {
                const parsed = JSON.parse(Buffer.from(data.subarray(zero + 1).toString('latin1'), 'base64').toString('utf8'));
                const book = parsed?.data?.character_book;
                return {
                    keyword: 'ccv3',
                    alternateGreetings: Array.isArray(parsed?.data?.alternate_greetings) ? parsed.data.alternate_greetings.length : 0,
                    bookEntries: Array.isArray(book?.entries) ? book.entries.length : 0,
                    regexScripts: Array.isArray(parsed?.data?.extensions?.regex_scripts) ? parsed.data.extensions.regex_scripts.length : 0,
                    helperScripts: Array.isArray(parsed?.data?.extensions?.tavern_helper?.scripts) ? parsed.data.extensions.tavern_helper.scripts.length : 0,
                    nameIsMarker: /^(?:MARK_\d{6}|M\d{6})/.test(String(parsed?.data?.name ?? '')),
                };
            }
        }
        offset = dataStart + length + 4;
        if (type === 'IEND') break;
    }
    return null;
}

// THE SAME TREE ON BOTH LEGS, STAGED BY THE PROBE RATHER THAN BY THE CI SHELL: two legs that each stage
// their own copy from the same builder cannot silently differ, and the report records the digests so the
// comparator can refuse a pair that did not start identical.
async function stageFixture(dataRoot) {
    const files = [
        { relative: path.join(USER_HANDLE, 'characters', CARD_FILE), bytes: buildPng([textChunk('chara', Buffer.from(JSON.stringify(CARD), 'utf8').toString('base64'))]) },
        { relative: path.join(USER_HANDLE, 'backgrounds', BACKGROUND_FILE), bytes: buildPng([textChunk('Comment', 'probe asset background')]) },
        { relative: path.join(USER_HANDLE, 'User Avatars', PERSONA_FILE), bytes: buildPng([textChunk('Comment', 'probe asset persona')]) },
    ];
    // THE COMMITTED REAL CARD, read from the repository and written under the name the character list shows. The
    // file's own `data.name` is a marker (`MARK_…`), so the filename is the staged name and the character's row is
    // found by it. A missing or unreadable fixture is a REFUSAL, not a silent skip: a leg that quietly ran without
    // the real card would report the synthetic-only numbers and look exactly like a pass.
    // THE FIXTURE PATH IS CHECKED BEFORE IT IS READ, AND THE MESSAGE NAMES THE PATH. A bare ENOENT cost a whole
    // run (40304309528): the failure said `open '.../tests/fixtures/real/card-a.png'`, which is a PATH BUG, and a
    // reader had to reconstruct where the path came from. The preflight says which file, whether it exists, and
    // what the probe expected, so the next occurrence is one line instead of one investigation.
    let realCardBytes;
    try {
        realCardBytes = await fs.readFile(REAL_CARD_RELATIVE);
    } catch (error) {
        throw new Error(`the committed real card is not readable at ${REAL_CARD_RELATIVE} (resolved from the probe module's own directory, so this is cwd-independent): ${String(error?.message ?? error)}. Run \`node tools/build-real-fixtures.mjs --out tests/browser/fixtures/real --card card-a=<original>\` to regenerate it.`);
    }
    const realCardStructure = describeCardStructure(realCardBytes);
    if (!realCardStructure) throw new Error(`${REAL_CARD_RELATIVE} has no ccv3 chunk, so the real card cannot be staged`);
    files.push({ relative: path.join(USER_HANDLE, 'characters', `${REAL_CARD_NAME}.png`), bytes: realCardBytes });
    const staged = [];
    for (const file of files) {
        const target = path.join(dataRoot, file.relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.bytes);
        staged.push({ relative: file.relative.split(path.sep).join('/'), byteLength: file.bytes.length, sha256: digest(file.bytes) });
    }
    return { files: staged.sort((left, right) => left.relative.localeCompare(right.relative)), realCardStructure };
}

const external = Boolean(process.env.PROBE_BASE_URL);
const port = await freePort();
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-asset-probe-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `asset-${external ? 'pinned' : 'gotavern'}-leg.json`)));

await fs.mkdir(dataRoot, { recursive: true });
const stagedFixture = await stageFixture(dataRoot);

let server = null;
let legConfig = process.env.PROBE_LEG_CONFIG_JSON ? JSON.parse(process.env.PROBE_LEG_CONFIG_JSON) : null;
if (!external) {
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    const binary = binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
    if (!binarySetting) {
        const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
        if (await new Promise(resolve => build.on('exit', resolve)) !== 0) throw new Error('go build ./cmd/gotavern failed');
    }
    // THE BINARY MUST LIVE IN THE INSTALL ROOT: `gotavern start` resolves InstallRoot as the directory of
    // the executable, so a binary left in an artifact directory would read tokenizers/ and create public/
    // THERE while every staged file here was ignored and the report still claimed it was staged.
    if (binarySetting) await fs.copyFile(binarySetting, binary);
    const tokenizerSource = path.join(repoRoot, 'upstream', 'tokenizers');
    await fs.cp(tokenizerSource, path.join(dataRoot, 'tokenizers'), { recursive: true });
    legConfig = await seedLegConfig(dataRoot);
    server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
}

const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;

// WHICH REQUESTS COUNT AS "AN IMAGE THE PAGE NEEDS". The prefix list is derived from the pinned
// frontend's own URL builders and from the static trees pinned mounts (AGENTS.md 42/44), not from
// whatever this scenario happened to request -- a list built from observed traffic would pass when a
// mount is missing, which is exactly the defect that shipped.
const ASSET_PREFIXES = [
    { prefix: '/thumbnail', kind: 'thumbnail' },
    { prefix: '/characters/', kind: 'character' },
    { prefix: '/backgrounds/', kind: 'background' },
    { prefix: '/User%20Avatars/', kind: 'persona' },
    { prefix: '/User Avatars/', kind: 'persona' },
    { prefix: '/assets/', kind: 'asset' },
    { prefix: '/user/images/', kind: 'user-image' },
    { prefix: '/img/', kind: 'static' },
    { prefix: '/scripts/extensions/', kind: 'extension' },
];

function classifyUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }
    const entry = ASSET_PREFIXES.find(candidate => url.pathname.startsWith(candidate.prefix.replace(/ /g, '%20')) || url.pathname.startsWith(candidate.prefix));
    if (!entry) return null;
    return { kind: entry.kind, pathAndQuery: `${url.pathname}${url.search}`, path: url.pathname };
}

const report = {
    schemaVersion: 1,
    question: 'does a browser loading the unmodified pinned frontend actually DISPLAY the character-list avatars, the chat avatars, the persona image and the background on this leg, and does every image it asks for answer?',
    subject: external ? 'pinned' : 'gotavern',
    baseURL: baseURL.replace(/:\d+$/, ':<port>'),
    provenance: {
        subject: external ? 'pinned' : 'gotavern',
        configFile: legConfig,
        // THE TREE THIS LEG SERVED. On the pinned leg the server's --data-root comes from
        // run-against-pinned.mjs; a probe that staged somewhere else produced a leg with an empty catalogue
        // in run 40202885055 (0 character rows, persona thumbnail 404 on pinned only).
        dataRoot: dataRoot.split(path.sep).slice(-2).join('/'),
        fixture: {
            userHandle: USER_HANDLE,
            files: stagedFixture.files,
            stagedBy: 'asset-probe.mjs (the same builder on both legs); user data lives at <dataRoot>/<handle>/… (src/users.js getUserDirectories)',
            // THE REAL CARD'S STRUCTURE, as staged. A comparison whose two legs both failed to stage the card
            // would have identical `files` lists and could not tell; these numbers are what makes "the real
            // card was in play" a measurement rather than an assumption (AGENTS.md 50's spirit: a harness whose
            // captures do not differ when its inputs differ must fail itself).
            realCard: {
                name: REAL_CARD_NAME,
                source: 'tests/browser/fixtures/real/card-a.png (the committed derivation)',
                ...stagedFixture.realCardStructure,
            },
        },
        // Recorded so a reader can tell a probe-faithfulness failure (nothing was requested) from a
        // product failure (things were requested and answered wrongly).
        assetPrefixes: ASSET_PREFIXES,
        viewport: { width: 1280, height: 900 },
    },
    imageRequests: [],
    listings: null,
    dom: null,
    console: [],
    consoleFailedToLoad: [],
    pageErrors: [],
    httpFailures: [],
    countLoaded: null,
    failure: null,
};

let browser;
try {
    await waitForServer(`${baseURL}/version`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('console', message => {
        const text = String(message.text()).slice(0, 400);
        report.console.push({ type: message.type(), text });
        // CHROME EMITS THIS FOR EVERY SUBRESOURCE IT COULD NOT GET, and it is the browser's own
        // complaint rather than a page script's: exactly the class of signal that was recorded beside a
        // green verdict last time.
        if (/Failed to load resource/i.test(text)) report.consoleFailedToLoad.push({ type: message.type(), text });
    });
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 400)));
    page.on('requestfailed', request => {
        const classified = classifyUrl(request.url());
        if (classified) report.httpFailures.push({ ...classified, error: String(request.failure()?.errorText ?? 'request failed').slice(0, 120) });
    });

    // IMAGE RESPONSES, captured as they arrive. The body is read inside the handler because a response
    // object is not guaranteed to hold its body after the page settles, and `byteLength` is the field
    // that distinguishes "200 with an error page" from "200 with a picture".
    const pending = [];
    page.on('response', response => {
        const classified = classifyUrl(response.url());
        if (!classified) return;
        const entry = { ...classified, status: response.status(), contentType: response.headers()['content-type'] ?? null, byteLength: null, sha256: null };
        report.imageRequests.push(entry);
        if (response.status() < 400) {
            pending.push(response.body().then(body => {
                entry.byteLength = body.length;
                // THE DIGEST IS WHAT SEPARATES "same picture" FROM "200 with an error page that happens to
                // be the same length". For `/thumbnail` the two legs are EXPECTED to differ (Jimp vs the
                // pure-Go codec), so the comparator records that difference as a declared divergence
                // instead of silently ignoring bytes.
                entry.sha256 = createHash('sha256').update(body).digest('hex');
            }, error => { entry.bodyError = String(error?.message ?? error).slice(0, 120); }));
        }
    });

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

    // THE CHARACTER LIST IS THE FIRST THING A USER SEES, and its avatars come from
    // `getThumbnailUrl('avatar', …)`. Waiting for the row rather than for a fixed delay: a `sleep` would
    // make a slow leg look like a broken one (AGENTS.md 33).
    await page.waitForSelector('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 60000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);

    // WHAT THE SERVER SAID THE USER HAS. Recorded so "no row rendered" can be attributed: a leg whose
    // catalogue answered zero characters has a fixture problem, a leg whose catalogue answered one but
    // rendered zero has a DOM or frontend problem, and those are different reports.
    report.listings = await page.evaluate(async () => {
        const script = await import('./script.js');
        const post = async (route, body) => {
            try {
                const response = await fetch(route, { method: 'POST', headers: script.getRequestHeaders(), body: JSON.stringify(body ?? {}) });
                const text = await response.text();
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { parsed = null; }
                const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : null);
                return {
                    route,
                    httpStatus: response.status,
                    contentType: response.headers.get('content-type'),
                    bodyLength: text.length,
                    listLength: list ? list.length : null,
                    firstEntry: list && list[0] ? { name: list[0].name ?? null, avatar: list[0].avatar ?? null } : null,
                    errorBody: list ? null : text.slice(0, 200),
                };
            } catch (error) {
                return { route, error: String(error?.message ?? error).slice(0, 200) };
            }
        };
        return {
            characters: await post('/api/characters/all', {}),
            backgrounds: await post('/api/backgrounds/all', {}),
        };
    }).catch(error => ({ error: String(error?.message ?? error).slice(0, 200) }));

    report.dom = await page.evaluate(() => {
        const describeImage = image => ({
            src: image.getAttribute('src'),
            resolvedSrc: image.currentSrc || image.src || null,
            complete: image.complete,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            alt: image.getAttribute('alt'),
        });
        const characterList = [...document.querySelectorAll('#rm_print_characters_block .avatar[data-type="character"] img')].map(describeImage);
        const personas = [...document.querySelectorAll('.avatar[data-type="persona"] img')].map(describeImage);
        // THE TEMPLATE PLACEHOLDER IS NOT AN AVATAR. #message_template carries `<img src="">`, and a run that
        // opens no chat leaves those in the DOM with complete=true and naturalWidth=0 -- which run 40202318194
        // counted as two broken avatars on both legs. Only an image the page actually gave a src is an avatar.
        const messages = [...document.querySelectorAll('.mes .mesAvatarWrapper .avatar img')].map(describeImage).filter(image => String(image.src ?? '') !== '');
        const backgroundElement = document.querySelector('#bg1');
        return {
            characterListCount: document.querySelectorAll('#rm_print_characters_block .avatar[data-type="character"]').length,
            characterList,
            personaCount: personas.length,
            personas,
            messageCount: document.querySelectorAll('.mes').length,
            messages,
            background: backgroundElement ? {
                computedBackgroundImage: getComputedStyle(backgroundElement).backgroundImage,
                inlineStyle: backgroundElement.getAttribute('style'),
            } : null,
            characterListPresent: Boolean(document.querySelector('#rm_print_characters_block')),
            // WHAT THE CONTAINER ACTUALLY HOLDS. `characterListCount` counts ONE selector; if the
            // frontend renders `.avatar` without `data-type` (or renders into another container) that
            // count is 0 while the list is fine, and a harness reading it would report a product defect.
            containerShape: (() => {
                const block = document.querySelector('#rm_print_characters_block');
                if (!block) return null;
                return {
                    children: block.children.length,
                    avatars: block.querySelectorAll('.avatar').length,
                    avatarsWithDataType: block.querySelectorAll('.avatar[data-type]').length,
                    dataTypes: [...new Set([...block.querySelectorAll('.avatar[data-type]')].map(node => node.getAttribute('data-type')))],
                    characterSelects: block.querySelectorAll('.character_select').length,
                    imgs: block.querySelectorAll('img').length,
                    htmlPrefix: String(block.innerHTML ?? '').slice(0, 400),
                };
            })(),
            // AND WHETHER THE PAGE'S OWN MODULE AGREES WITH THE CATALOGUE IT JUST FETCHED.
            scriptCharacters: (() => { try { return null; } catch { return null; } })(),
        };
    });

    // THE FRONTEND'S OWN RENDERER, AND WHAT IT CHANGED. Recorded as two numbers so the artefact cannot
    // claim a plain page load rendered a list that an explicit call rendered.
    const rowsAfterLoad = (report.dom.containerShape?.avatars ?? 0);
    report.dom.render = await page.evaluate(async () => {
        const script = await import('./script.js');
        if (typeof script.printCharacters !== 'function') {
            return { invoked: false, reason: 'script.js exports no printCharacters' };
        }
        // THE LOADER FIRST. Without it the renderer faithfully draws an empty array -- measured in run
        // 40204846563, where both legs rendered pinned's own "There are no items to display" while the
        // catalogue answered 2 entries. Both functions are the frontend's own exported entry points.
        let loader = null;
        try {
            if (typeof script.getCharacters === 'function') {
                await script.getCharacters();
                loader = { invoked: true };
            } else {
                loader = { invoked: false, reason: 'script.js exports no getCharacters' };
            }
        } catch (error) {
            loader = { invoked: false, reason: String(error?.message ?? error).slice(0, 200) };
        }
        await script.printCharacters(true);
        const deadline = performance.now() + 20000;
        let block = document.querySelector('#rm_print_characters_block');
        while (performance.now() < deadline) {
            block = document.querySelector('#rm_print_characters_block');
            if (block && block.querySelectorAll('.avatar').length > 0) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return {
            invoked: true,
            loader,
            rowsAfterRender: block ? block.querySelectorAll('.avatar').length : null,
            imgsAfterRender: block ? block.querySelectorAll('img').length : null,
            htmlPrefix: block ? String(block.innerHTML ?? '').slice(0, 300) : null,
        };
    }).catch(error => ({ invoked: false, reason: String(error?.message ?? error).slice(0, 200) }));
    report.dom.rowsAfterLoad = rowsAfterLoad;
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);

    // THE AVATARS THAT ACTUALLY EXIST NOW. The pre-render capture is kept as `characterListBeforeRender`
    // for the record, and `characterList` becomes the POST-render list -- which is the one a user sees and
    // the one the comparator must assert on.
    report.dom.characterListBeforeRender = report.dom.characterList;
    // WAIT FOR THE PICTURES BEFORE ASKING WHETHER THEY DECODED. Run 40206135746 recorded `complete: false,
    // naturalWidth: 0` on avatars whose own requests had answered 200 with bytes, because the descriptor was
    // read while the image was still loading -- a race that reads as "avatars are broken" (the same class as
    // `sleep` masking a readiness race, AGENTS.md 33). A user sees the avatar once it has loaded, so the probe
    // waits for every `<img>` to settle (load or error) with a bound, and records what each one did.
    report.dom.imagesSettled = await page.evaluate(async () => {
        const block = document.querySelector('#rm_print_characters_block');
        if (!block) return { settled: 0, broken: 0, timedOut: 0, outcomes: [] };
        const images = [...block.querySelectorAll('.avatar img')];
        const outcomes = await Promise.all(images.map(image => new Promise(resolve => {
            if (image.complete && image.naturalWidth > 0) return resolve('loaded');
            if (image.complete && image.naturalWidth === 0) return resolve('broken');
            const timer = setTimeout(() => resolve('timeout'), 20000);
            image.addEventListener('load', () => { clearTimeout(timer); resolve('loaded'); }, { once: true });
            image.addEventListener('error', () => { clearTimeout(timer); resolve('broken'); }, { once: true });
        })));
        return {
            settled: outcomes.filter(outcome => outcome === 'loaded').length,
            broken: outcomes.filter(outcome => outcome === 'broken').length,
            timedOut: outcomes.filter(outcome => outcome === 'timeout').length,
            outcomes,
        };
    });
    report.dom.characterList = await page.evaluate(() => {
        const block = document.querySelector('#rm_print_characters_block');
        if (!block) return [];
        return [...block.querySelectorAll('.avatar')].map(node => {
            const image = node.querySelector('img');
            return {
                src: image ? image.getAttribute('src') : null,
                resolvedSrc: image ? (image.currentSrc || image.src || null) : null,
                complete: image ? image.complete : null,
                naturalWidth: image ? image.naturalWidth : null,
                naturalHeight: image ? image.naturalHeight : null,
                alt: image ? image.getAttribute('alt') : null,
                dataType: node.getAttribute('data-type'),
            };
        });
    });
    report.dom.characterListCount = report.dom.characterList.length;

    // OPEN THE CHAT: a user clicks the card, and the greeting renders, which is what puts a chat-message
    // avatar in the DOM (`#message_template .mesAvatarWrapper .avatar img`).
    // THE REAL CARD IS OPENED, NOT THE SYNTHETIC ONE. The swipe drive below needs a card with alternate greetings
    // and the persona/background drives are indifferent, so opening the REAL card is strictly more evidence: the
    // chat avatar is then the avatar of a 490-entry card whose `ccv3` chunk a reader had to reach, and the swipe
    // has five greetings to move through. The synthetic card stays in the tree as a second row, so the
    // character-list assertions still cover two avatars.
    report.dom.clickTarget = await page.evaluate((realCardName) => {
        const block = document.querySelector('#rm_print_characters_block');
        const avatars = [...document.querySelectorAll('#rm_print_characters_block .avatar[data-type="character"], #rm_print_characters_block .avatar[data-chid]')];
        // The row is matched by the avatar's own `title`/`alt`/filename, which the frontend sets from the staged
        // file name (`buildAvatarList` uses the file name for `getThumbnailUrl('avatar', file)`).
        const realRow = avatars.find(node => {
            const haystack = `${node.getAttribute('title') ?? ''} ${node.getAttribute('data-chid') ?? ''} ${node.querySelector('img')?.getAttribute('alt') ?? ''} ${node.querySelector('img')?.getAttribute('src') ?? ''}`;
            return haystack.includes(realCardName);
        }) ?? null;
        const candidates = [
            realRow,
            document.querySelector('#rm_print_characters_block .avatar[data-type="character"]'),
            document.querySelector('#rm_print_characters_block .avatar[data-chid]'),
            document.querySelector('#rm_print_characters_block .avatar'),
            document.querySelector('#rm_print_characters_block .character_select'),
            document.querySelector('#rm_print_characters_block img'),
        ].filter(Boolean);
        for (const element of candidates) {
            const target = element.closest('.character_select') ?? element;
            target.click();
            return { selector: element === realRow ? '.avatar[data-type="character"] (matched the real card)' : 'fallback', clicked: true, openedRealCard: element === realRow };
        }
        return { selector: null, clicked: false, blockPresent: Boolean(block), blockChildren: block ? block.children.length : null, openedRealCard: false };
    }, REAL_CARD_NAME);
    await page.waitForSelector('.mes .mesAvatarWrapper .avatar img', { timeout: 30000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);

    const afterOpen = await page.evaluate(() => {
        const describeImage = image => ({
            src: image.getAttribute('src'),
            resolvedSrc: image.currentSrc || image.src || null,
            complete: image.complete,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            alt: image.getAttribute('alt'),
        });
        return {
            messageCount: document.querySelectorAll('.mes').length,
            // Same placeholder rule as the first capture: an <img src=""> from #message_template is not an
            // avatar, and counting it makes "no chat opened" indistinguishable from "avatars are broken".
            messages: [...document.querySelectorAll('.mes .mesAvatarWrapper .avatar img')].map(describeImage).filter(image => String(image.src ?? '') !== ''),
        };
    });
    report.dom.messageCount = afterOpen.messageCount;
    report.dom.messages = afterOpen.messages;

    // THE BACKGROUND, through the panel a user opens. The gallery tile's thumbnail is LAZY
    // (`lazy-load-background`), so the probe records the tile and then clicks it and waits for `#bg1`,
    // which is the element the pinned frontend applies the background to.
    report.dom.backgroundDriven = await page.evaluate(async backgroundFile => {
        const backgrounds = await import('./scripts/backgrounds.js');
        const toggle = document.querySelector('#backgrounds-drawer-toggle');
        if (!toggle) return { status: 'not-driven', reason: 'no #backgrounds-drawer-toggle in the served frontend' };
        // OPEN IT ONLY IF IT IS CLOSED, and wait for the panel's own class. Calling `toggle` on an already-open
        // drawer CLOSES it -- which is what happened to the persona drawer in run 40314670847, where the row had a
        // 0x0 box and no click could reach it. A background tile inside a closed drawer has the same problem.
        const panel = document.querySelector('#Backgrounds');
        const waitForOpen = async (deadlineMs) => {
            const until = performance.now() + deadlineMs;
            while (performance.now() < until) {
                const current = document.querySelector('#Backgrounds');
                if (current && !current.classList.contains('closedDrawer')) return true;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return false;
        };
        let drawerWasAlreadyOpen = Boolean(panel) && !panel.classList.contains('closedDrawer');
        if (!drawerWasAlreadyOpen) toggle.click();
        const drawerOpened = drawerWasAlreadyOpen || await waitForOpen(15000);
        // THE FRONTEND'S OWN RENDERER, CALLED THE WAY THE PAGE CALLS IT ON LOAD (script.js `await getBackgrounds()`
        // in the startup sequence). The earlier drive only opened the drawer and waited, and measured NO tile on
        // either leg -- which is a harness-faithfulness alarm, not a product finding (AGENTS.md 7 / rule 10):
        // opening a drawer does not re-fetch, and on a leg whose startup call had already run (or whose account
        // handle differed) the gallery is as empty as the catalogue says. Calling `getBackgrounds()` and recording
        // what it RETURNED is what turns "no tile appeared" into a named cause.
        let fetched = null;
        let fetchError = null;
        try {
            fetched = await backgrounds.getBackgrounds();
            fetched = { returned: fetched === undefined ? null : String(JSON.stringify(fetched ?? null)).slice(0, 400) };
        } catch (error) {
            fetchError = `getBackgrounds threw: ${String(error?.message ?? error).slice(0, 300)}`;
        }
        const deadline = performance.now() + 15000;
        let tile = null;
        while (performance.now() < deadline) {
            tile = document.querySelector(`.bg_example[bgfile="${backgroundFile}"]`);
            if (tile) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        // WHAT THE GALLERY CONTAINS, WHETHER OR NOT THE STAGED TILE IS AMONG IT. An empty gallery and a gallery
        // missing one tile are different findings, and only this distinguishes them.
        //
        // THE LIST IS NOT TRUNCATED, and that is AGENTS.md 11's lesson applied to a DOM query: the first version
        // sliced the first 12 bgfiles "for the artefact's size", the staged tile sorted after them, and the
        // comparator reported "the gallery did not render the staged tile" on BOTH legs while `tileBgFile` in the
        // same object said it had (run 40307800425: 24 tiles, staged file present, guard red). A bounded listing
        // can never support a claim of absence.
        const gallery = {
            tiles: document.querySelectorAll('#bg_menu_content .bg_example').length,
            bgFiles: [...document.querySelectorAll('#bg_menu_content .bg_example')].map(node => node.getAttribute('bgfile')),
            stagedTilePresent: Boolean(document.querySelector(`#bg_menu_content .bg_example[bgfile="${backgroundFile}"]`)),
            drawerOpen: Boolean(document.querySelector('#Backgrounds')) && !document.querySelector('#Backgrounds').classList.contains('closedDrawer'),
            drawerOpenedByDrive: drawerOpened,
            drawerWasAlreadyOpen,
            panelContent: document.querySelector('#bg_menu_content')?.innerHTML?.slice(0, 200) ?? null,
            fetchError,
            fetched,
        };
        if (!tile) {
            return { status: 'not-driven', reason: `no .bg_example[bgfile="${backgroundFile}"] appeared within 15s of opening the panel`, gallery };
        }
        const clipper = tile.querySelector('.thumbnail-clipper');
        const before = clipper ? getComputedStyle(clipper).backgroundImage : null;
        tile.scrollIntoView();
        // The lazy loader fires on intersection; give it a moment, then click, which is what a user does.
        await new Promise(resolve => setTimeout(resolve, 1500));
        const after = clipper ? getComputedStyle(clipper).backgroundImage : null;
        // THE TILE'S `data-url` IS SET WITH jQuery `.data()`, NOT AS AN ATTRIBUTE (backgrounds.js:186
        // `thumbnail.data('url', url)`), so `getAttribute('data-url')` is null on a perfectly good tile -- measured
        // in run 40307800425 on both legs. Reading it the way the subject does is what makes this field mean
        // something.
        const dataUrl = globalThis.jQuery ? globalThis.jQuery(tile).data('url') ?? null : null;
        // WHAT THE CLICK DID, FROM THE PAGE'S OWN STATE. The gallery marks the applied tile `selected-background`,
        // and `onSelectBackgroundClick` either calls `setBackground` (writes `#bg1` and `background_settings`) or the
        // locked-background branch. Recording all three separates "the click never reached the handler" from "the
        // handler ran and refused" from "the handler ran and painted".
        const beforeSelection = [...document.querySelectorAll('#bg_menu_content .bg_example.selected-background')].map(node => node.getAttribute('bgfile'));
        // THE HANDLER'S OWN REGISTRATION, as the subject records it. `initBackgrounds` binds
        // `.on('click', '.bg_example', onSelectBackgroundClick)` on `document` (backgrounds.js:1732-1733), and it
        // is called at startup (script.js:762). The first version of this predicate reported "NOT BOUND" on both
        // legs (run 40314670847) while the click handler demonstrably existed, so the recorded value now includes
        // the handler SELECTORS, which is what makes the next report falsifiable instead of a claim about jQuery's
        // internals. `delegatedBgClickBound` stays the single boolean the comparator reads.
        const documentClickHandlers = globalThis.jQuery?._data?.(document, 'events')?.click ?? [];
        const handlerSelectors = documentClickHandlers.map(handler => String(handler.selector ?? null));
        const delegatedBgClickBound = handlerSelectors.some(selector => selector.includes('bg_example'));
        // WHY THE HANDLER MIGHT BE MISSING. `initBackgrounds()` is called at script.js:762, between
        // `await getBackgrounds()` (:760) and `await initPersonas()` (:764), so the startup sequence is the first
        // suspect. TWO CORRECTIONS ARE RECORDED HERE RATHER THAN LOST:
        //   * the first version read `globalThis.tokenizers`, which is NOT a global in pinned 1.19.0 -- the
        //     module keeps its own array -- so `tokenizerReady:false` was MY probe error and not a finding. A
        //     measurement of a name that does not exist is a measurement of nothing;
        //   * `addBgButtonBound` and `bgTabHandlers` ARE real: both are bound INSIDE `initBackgrounds`, so their
        //     absence is evidence that the function did not finish, and the module's own exports are read through
        //     the SAME dynamic import the rest of this drive uses.
        let tokenizerModuleState = null;
        try {
            const tokenizers = await import('./scripts/tokenizers.js');
            tokenizerModuleState = {
                exportsInitTokenizers: typeof tokenizers.initTokenizers === 'function',
                exportsCountsFor: typeof tokenizers.countTokensOpenAI === 'function' || typeof tokenizers.countTokens === 'function',
            };
        } catch (error) {
            tokenizerModuleState = { error: String(error?.message ?? error).slice(0, 200) };
        }
        const startupEvidence = {
            backgroundSettingsName: globalThis.background_settings?.name ?? null,
            addBgButtonPresent: Boolean(document.querySelector('#add_bg_button')),
            addBgButtonBound: Boolean(globalThis.jQuery?._data?.(document.querySelector('#add_bg_button'), 'events')?.change?.length),
            bgTabsPresent: Boolean(document.querySelector('#bg_tabs')),
            bgTabHandlers: Boolean(globalThis.jQuery?._data?.(document.querySelector('#bg_tabs'), 'events')?.tabsactivate?.length),
            bgFoldersRequested: Boolean(document.querySelector('#bg_folder_grid')),
            tokenizerModule: tokenizerModuleState,
            documentClickHandlers: documentClickHandlers.length,
        };
        const tileBox = tile.getBoundingClientRect();
        tile.click();
        // A REAL MOUSE EVENT IF THE SYNTHETIC ONE CHANGED NOTHING. `onSelectBackgroundClick` is bound through
        // jQuery's delegated `.on('click', '.bg_example', …)` (backgrounds.js:1732-1733), which listens for a
        // bubbling click from a TRUSTED-ish target inside the gallery. `element.click()` is the ordinary way to do
        // that and is tried first; if the page's own selection state did not move, a bubbling MouseEvent is
        // dispatched once, and WHICH PATH WORKED is recorded. A no-op click is exactly what run 40307800425
        // measured, so the drive must not simply wait longer for a handler that never ran.
        let clickPath = 'element.click()';
        const quickDeadline = performance.now() + 3000;
        let selectionMoved = false;
        while (performance.now() < quickDeadline) {
            selectionMoved = document.querySelector('#bg_menu_content .bg_example.selected-background')?.getAttribute('bgfile') === backgroundFile;
            if (selectionMoved) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!selectionMoved) {
            tile.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            clickPath = 'element.click() then a bubbling MouseEvent';
        }
        const bgDeadline = performance.now() + 15000;
        let applied = null;
        let selectedTile = null;
        while (performance.now() < bgDeadline) {
            const element = document.querySelector('#bg1');
            applied = element ? getComputedStyle(element).backgroundImage : null;
            selectedTile = document.querySelector('#bg_menu_content .bg_example.selected-background')?.getAttribute('bgfile') ?? null;
            if (applied && applied !== 'none' && applied.includes(backgroundFile)) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return {
            status: 'observed',
            tileBgFile: tile.getAttribute('bgfile'),
            tileDataUrl: dataUrl,
            tileThumbnailBeforeLoad: before,
            tileThumbnailAfterLoad: after,
            appliedBackgroundImage: applied,
            selectedTileBeforeClick: beforeSelection,
            selectedTileAfterClick: selectedTile,
            clickPath,
            delegatedBgClickBound,
            handlerSelectors: handlerSelectors,
            startupEvidence,
            tileBox: { width: Math.round(tileBox.width), height: Math.round(tileBox.height) },
            // WHICH BRANCH THE HANDLER TOOK. `isChatBackgroundLocked()` reads `chat_metadata.bg`; a locked chat
            // paints `#bg1` directly and never touches `background_settings`, so the two are recorded apart.
            chatBackgroundLocked: Boolean(globalThis.chat_metadata?.bg),
            backgroundSettingsName: globalThis.oai_settings?.background?.name ?? globalThis.background_settings?.name ?? null,
            gallery,
        };
    }, BACKGROUND_FILE).catch(error => ({ status: 'not-driven', reason: `the background drive threw: ${String(error?.message ?? error).slice(0, 160)}` }));
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
    // DID THE STAGED BACKGROUND ITSELF REACH #bg1? A fresh tree applies /backgrounds/__transparent.png, so an
    // "applied background" observation that accepts any URL would pass while the staged image never rendered.
    report.dom.stagedBackgroundDriven = Boolean(
        report.dom.backgroundDriven &&
        String(report.dom.backgroundDriven.appliedBackgroundImage ?? '').includes(BACKGROUND_FILE),
    );
    // THE STAGED BACKGROUND'S OWN URL, ASKED THE WAY THE PAGE ASKS FOR IT. The gallery drive above is not
    // established (the panel opens and no .bg_example[bgfile=...] appears), so the DOM half of the background
    // claim is recorded as unproven rather than dressed up. What IS measured here is the asset the user's
    // background resolves to: `/backgrounds/<file>`, which is exactly the URL `#bg1` receives from
    // backgrounds.js. A 200 with bytes on both legs is the route-level half of Q7; the paint is not claimed.
    report.dom.stagedBackgroundRequest = await page.evaluate(async backgroundFile => {
        const script = await import('./script.js');
        const url = `/backgrounds/${encodeURIComponent(backgroundFile)}`;
        const headers = typeof script.getRequestHeaders === 'function' ? script.getRequestHeaders() : {};
        const response = await fetch(url, { headers });
        const bytes = await response.arrayBuffer();
        return { url, httpStatus: response.status, contentType: response.headers.get('content-type'), byteLength: bytes.byteLength };
    }, BACKGROUND_FILE).catch(error => ({ url: `/backgrounds/${BACKGROUND_FILE}`, error: String(error?.message ?? error).slice(0, 160) }));

    // THE PERSONA PICKER, DRIVEN THROUGH THE PANEL A USER OPENS.
    //
    // WHY THE FIRST ATTEMPT AT THIS SURFACE WAS "not-driven" AND WHY THAT IS NO LONGER ACCEPTABLE: the persona
    // row is built by `getUserAvatars()` -> `getUserAvatarBlock()`, which reads `power_user.personas[avatarId]`;
    // a persona that does not exist in `power_user` never renders a row (personas.js:231-254, and
    // `addMissingPersonas` is what creates them). So the drive is the frontend's OWN entry point
    // (`getUserAvatars(true)`), then the drawer's toggle, then a CLICK on the row -- which is what a user does and
    // what `setUserAvatar` listens for (personas.js:2972-2975). Recording "the request answers" is the ROUTE
    // half; this records the DOM half.
    report.dom.personaPicker = await page.evaluate(async (personaFile) => {
        const personas = await import('./scripts/personas.js');
        const states = { steps: [] };
        if (typeof personas.getUserAvatars !== 'function') return { status: 'not-driven', reason: 'personas.js exports no getUserAvatars' };
        // The subject's own gate, read from its source: the drawer's content must be open for the picker to be
        // interactive, and `isPersonaPanelOpen()` is the module's own predicate for that.
        const toggle = document.querySelector('#persona-management-button .drawer-toggle');
        if (!toggle) return { status: 'not-driven', reason: 'no #persona-management-button .drawer-toggle in the served frontend' };
        try {
            const list = await personas.getUserAvatars(true);
            states.listed = Array.isArray(list) ? list.length : null;
            states.steps.push('getUserAvatars(true)');
        } catch (error) {
            return { status: 'not-driven', reason: `getUserAvatars threw: ${String(error?.message ?? error).slice(0, 160)}` };
        }
        // WHETHER THE DRAWER IS ACTUALLY OPEN BEFORE THE DRIVE CLICKS. The row is inside `#PersonaManagement`,
        // and `rowBox` measured 0x0 with `drawerIsOpen:false` in run 40314670847 -- the drive's own open click had
        // closed the drawer it believed it was opening (calling `toggle` twice). The panel's own predicate,
        // `isPersonaPanelOpen()`, is the gate a user has to satisfy before a row is clickable at all.
        if (!personas.isPersonaPanelOpen()) {
            toggle.click();
            states.steps.push('opened the drawer');
            // WAIT FOR THE PANEL'S OWN PREDICATE, not for a delay: a closed drawer means every row has a 0x0 box
            // and no click can reach it, which is exactly what the last run measured.
            const openDeadline = performance.now() + 15000;
            while (performance.now() < openDeadline && !personas.isPersonaPanelOpen()) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } else {
            states.steps.push('the drawer was already open');
        }
        const deadline = performance.now() + 15000;
        let rows = [];
        while (performance.now() < deadline) {
            rows = [...document.querySelectorAll('#user_avatar_block .avatar-container')];
            if (rows.some(row => row.getAttribute('data-avatar-id') === personaFile)) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        const row = rows.find(candidate => candidate.getAttribute('data-avatar-id') === personaFile) ?? null;
        if (!row) {
            return {
                status: 'not-driven',
                reason: `no #user_avatar_block .avatar-container[data-avatar-id="${personaFile}"] appeared`,
                listed: states.listed,
                rowCount: rows.length,
                rowIds: rows.slice(0, 10).map(candidate => candidate.getAttribute('data-avatar-id')),
                panelOpen: personas.isPersonaPanelOpen(),
                steps: states.steps,
            };
        }
        // THE ROW'S IMAGE, SETTLED, BEFORE THE CLICK: the row's `<img>` is `getThumbnailUrl('persona', id)`
        // (personas.js:243-244), so a row that exists with a broken image is exactly the user-visible failure.
        const image = row.querySelector('img');
        const settled = await new Promise(resolve => {
            if (!image) return resolve('no-img');
            if (image.complete && image.naturalWidth > 0) return resolve('loaded');
            if (image.complete && image.naturalWidth === 0) return resolve('broken');
            const timer = setTimeout(() => resolve('timeout'), 20000);
            image.addEventListener('load', () => { clearTimeout(timer); resolve('loaded'); }, { once: true });
            image.addEventListener('error', () => { clearTimeout(timer); resolve('broken'); }, { once: true });
        });
        const beforeClick = {
            src: image ? image.getAttribute('src') : null,
            complete: image ? image.complete : null,
            naturalWidth: image ? image.naturalWidth : null,
            naturalHeight: image ? image.naturalHeight : null,
            settled,
        };
        // THE SUBJECT'S OWN PRE-STATE, read from its source rather than assumed (AGENTS.md 10). `setUserAvatar`
        // does `if (currentUserAvatar === user_avatar) return;` (personas.js:154-159), so clicking the persona that
        // is ALREADY selected is a no-op BY DESIGN and cannot prove selection works. Run 40307800425 clicked
        // `user-default.png` -- the default persona -- and recorded `selectedAfterClick:false` on BOTH legs with the
        // heading still "User", which is a probe-faithfulness alarm (rule 10), not a product finding: the drive
        // picked a row where the subject is designed to do nothing. The pre-state is recorded so that can never be
        // read as a product failure again, and the drive prefers a row that is NOT the current persona.
        const currentBefore = typeof personas.user_avatar === 'string' ? personas.user_avatar : null;
        const isPrimary = row.classList.contains('default_persona');
        // PREFER A NON-CURRENT ROW, which is the only click whose effect the subject's own guard permits.
        const alternative = rows.find(candidate => candidate.getAttribute('data-avatar-id') !== currentBefore) ?? null;
        const clickTarget = alternative ?? row;
        const clickedId = clickTarget.getAttribute('data-avatar-id');
        // THREE PRECONDITIONS THE DELEGATED HANDLER NEEDS, recorded because "the click did nothing" has four
        // possible causes and only one of them is the product (AGENTS.md 10):
        //   * the delegated handler bound? `jQuery._data(document, 'events').click` is the same predicate the
        //     backgrounds drive uses, and it is the subject's own registration;
        //   * the row visible and hit-testable? A click on a display:none element never reaches a delegated
        //     listener that filters on visibility;
        //   * the row inside the panel's own content? `#user_avatar_block` must be a descendant of the open
        //     drawer for a user to click it at all.
        const rowBox = clickTarget.getBoundingClientRect();
        const rowStyle = getComputedStyle(clickTarget);
        const preconditions = {
            delegatedClickBound: Boolean(globalThis.jQuery?._data?.(document, 'events')?.click?.length),
            rowVisible: rowStyle.display !== 'none' && rowStyle.visibility !== 'hidden' && rowBox.width > 0 && rowBox.height > 0,
            rowInDrawer: Boolean(clickTarget.closest('#persona-management-button #PersonaManagement')),
            drawerIsOpen: Boolean(document.querySelector('#PersonaManagement')) && !document.querySelector('#PersonaManagement').classList.contains('closedDrawer'),
            rowBox: { width: Math.round(rowBox.width), height: Math.round(rowBox.height) },
        };
        clickTarget.scrollIntoView({ block: 'center' });
        clickTarget.click();
        states.steps.push(alternative ? 'clicked a NON-CURRENT row' : 'clicked the only row (the current persona)');
        // IF THE CLICK CHANGED NOTHING, ASK THE MODULE DIRECTLY. `setUserAvatar(id)` is the function the handler
        // calls, so invoking it separates "the delegated handler is not reaching this row" (a probe/UI defect)
        // from "the handler ran and setUserAvatar refused" (a product defect). Which path worked is recorded.
        const quickAfterClick = typeof personas.user_avatar === 'string' ? personas.user_avatar : null;
        let directCall = null;
        if (quickAfterClick === currentBefore) {
            try {
                await personas.setUserAvatar(clickedId, { toastPersonaNameChange: false });
                directCall = { invoked: true, userAvatarAfter: typeof personas.user_avatar === 'string' ? personas.user_avatar : null };
            } catch (error) {
                directCall = { invoked: false, reason: String(error?.message ?? error).slice(0, 200) };
            }
            states.steps.push('the click changed nothing, so setUserAvatar was called directly');
        }
        // THE PICKER'S EFFECT, OBSERVED THE WAY A USER SEES IT. `setUserAvatar` sets `user_avatar`, then
        // `updatePersonaUIStates` marks the row `.selected` and the panel's `#your_name` takes the persona's name
        // and `#user_avatar_block`'s title. A click that the subject's own guard short-circuits leaves all three
        // unchanged, and each is recorded SEPARATELY so "the click did nothing" and "the click changed the model
        // but not the DOM" are different findings.
        const appliedDeadline = performance.now() + 15000;
        let selected = false;
        let heading = null;
        let userAvatarAfter = null;
        while (performance.now() < appliedDeadline) {
            const target = document.querySelector(`#user_avatar_block .avatar-container[data-avatar-id="${clickedId}"]`);
            selected = Boolean(target && target.classList.contains('selected'));
            heading = document.querySelector('#your_name')?.textContent?.trim() ?? null;
            userAvatarAfter = typeof personas.user_avatar === 'string' ? personas.user_avatar : null;
            if (selected) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return {
            status: 'observed',
            listed: states.listed,
            rowCount: rows.length,
            rowIds: rows.map(candidate => candidate.getAttribute('data-avatar-id')),
            steps: states.steps,
            rowImage: beforeClick,
            // The pre-state the subject's own guard reads, and which row the drive chose BECAUSE of it.
            currentPersonaBefore: currentBefore,
            clickedAvatarId: clickedId,
            clickedWasCurrentBefore: clickedId === currentBefore,
            clickedIsDefaultPersona: isPrimary,
            preconditions,
            directCall,
            // WHETHER THE CLICK ALONE WAS ENOUGH. A `true` here means the delegated path worked; a `false` with a
            // `directCall.userAvatarAfter` that DID change means the module works and the CLICK PATH does not,
            // which is a different report from either a product or a probe defect.
            clickAloneChangedPersona: directCall === null,
            userAvatarAfter,
            personaChanged: typeof userAvatarAfter === 'string' && userAvatarAfter !== currentBefore,
            selectedAfterClick: selected,
            currentPersonaHeading: heading,
        };
    }, PERSONA_FILE).catch(error => ({ status: 'not-driven', reason: `the persona picker drive threw: ${String(error?.message ?? error).slice(0, 200)}` }));

    // A SWIPED MESSAGE'S AVATAR (GOAL.md §8.4 Q5, the gap recorded as "the chat is opened once and one greeting
    // renders"). A swipe is not a cosmetic difference here: it REPLACES the message's text and re-renders the
    // same `.mes`, and the avatar in that re-render is a fresh `<img>`. The drive is the frontend's own swipe
    // handler (`.swipe_right` inside the last `.mes`), and the observation is the avatar AFTER the text changed,
    // so "the avatar decoded on first render" cannot stand in for "the avatar decodes on every render".
    //
    // THE REAL CARD IS WHAT MAKES THIS POSSIBLE: it carries five alternate greetings, so a swipe has somewhere to
    // go. The synthetic card has none, and a swipe on it is a no-op that a weaker probe would record as success.
    report.dom.swipedMessageAvatar = await page.evaluate(async realCardName => {
        const mesNodes = [...document.querySelectorAll('.mes')];
        const last = mesNodes[mesNodes.length - 1] ?? null;
        if (!last) return { status: 'not-driven', reason: 'no .mes in the DOM to swipe' };
        const textOf = node => String(node?.querySelector('.mes_text')?.textContent ?? '');
        const avatarOf = node => {
            const image = node?.querySelector('.mesAvatarWrapper .avatar img') ?? null;
            if (!image) return null;
            return {
                src: image.getAttribute('src'),
                resolvedSrc: image.currentSrc || image.src || null,
                complete: image.complete,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
            };
        };
        const settle = async node => {
            const image = node?.querySelector('.mesAvatarWrapper .avatar img') ?? null;
            if (!image) return 'no-img';
            return new Promise(resolve => {
                if (image.complete && image.naturalWidth > 0) return resolve('loaded');
                if (image.complete && image.naturalWidth === 0) return resolve('broken');
                const timer = setTimeout(() => resolve('timeout'), 20000);
                image.addEventListener('load', () => { clearTimeout(timer); resolve('loaded'); }, { once: true });
                image.addEventListener('error', () => { clearTimeout(timer); resolve('broken'); }, { once: true });
            });
        };
        const before = { text: textOf(last).slice(0, 120), avatar: avatarOf(last), settled: await settle(last) };
        // The subject's own gate: the swipe control must exist, or the caller cannot swipe at all.
        const swipes = last.querySelectorAll('.swipes .swipe_right, .swipe_right');
        const swipe = swipes[swipes.length - 1] ?? null;
        if (!swipe) {
            return {
                status: 'not-driven',
                reason: `the last .mes carries no .swipe_right (character ${JSON.stringify(realCardName)}); the card in play has no alternate greeting to swipe to`,
                before,
            };
        }
        swipe.click();
        // WAIT FOR THE TEXT TO CHANGE, which is the observable that proves the swipe ran. A fixed delay would make
        // a slow leg look broken (AGENTS.md 33) and a fast no-op look successful.
        const deadline = performance.now() + 20000;
        let after = null;
        while (performance.now() < deadline) {
            const current = [...document.querySelectorAll('.mes')].at(-1) ?? null;
            const text = textOf(current);
            if (current && text !== before.text && text.length > 0) {
                after = current;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!after) {
            return { status: 'not-driven', reason: 'the message text did not change after clicking .swipe_right within 20 s', before };
        }
        // THE AVATAR IS READ AFTER THE RE-RENDER AND WAITED FOR, so a not-yet-loaded image is not reported as a
        // broken one (the class of race that produced a phantom defect in run 40206135746).
        const settledAfter = await settle(after);
        return {
            status: 'observed',
            character: realCardName,
            before,
            after: { text: textOf(after).slice(0, 120), avatar: avatarOf(after), settled: settledAfter },
            textChanged: textOf(after) !== before.text,
        };
    }, REAL_CARD_NAME).catch(error => ({ status: 'not-driven', reason: `the swipe drive threw: ${String(error?.message ?? error).slice(0, 200)}` }));

    // THE PERSONA SURFACE, ASKED OF THE SERVER THROUGH THE FRONTEND'S OWN HELPER. Kept beside the picker drive
    // because the two answer different halves: this one is the REQUEST the frontend builds
    // (`getThumbnailUrl('persona', …)`), the drive above is the PICTURE the browser ends up showing.
    report.dom.personaRequest = await page.evaluate(async personaFile => {
        const script = await import('./script.js');
        if (typeof script.getThumbnailUrl !== 'function') return { status: 'not-driven', reason: 'script.js exports no getThumbnailUrl' };
        const url = script.getThumbnailUrl('persona', personaFile);
        const response = await fetch(url);
        const bytes = await response.arrayBuffer();
        return { status: 'observed', url, httpStatus: response.status, contentType: response.headers.get('content-type'), byteLength: bytes.byteLength };
    }, PERSONA_FILE).catch(error => ({ status: 'not-driven', reason: String(error?.message ?? error).slice(0, 160) }));

    await Promise.all(pending);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);

    // DEDUPLICATED BY PATH+QUERY: the frontend re-requests a thumbnail after a cache-busting `t=`, and two
    // entries for one URL would make a per-URL comparison report a phantom difference.
    const seen = new Map();
    for (const entry of report.imageRequests) {
        const key = entry.pathAndQuery;
        const previous = seen.get(key);
        if (!previous || (previous.status >= 400 && entry.status < 400)) seen.set(key, entry);
    }
    report.imageRequests = [...seen.values()].sort((left, right) => left.pathAndQuery.localeCompare(right.pathAndQuery));

    // THE COUNTS A READER NEEDS FIRST, computed rather than left to arithmetic in the comparator.
    report.countLoaded = {
        imagesRequested: report.imageRequests.length,
        imagesFailed: report.imageRequests.filter(entry => entry.status >= 400).length,
        characterListAvatars: report.dom.characterList.length,
        characterListDecoded: report.dom.characterList.filter(image => image.complete && image.naturalWidth > 0).length,
        messageAvatars: report.dom.messages.length,
        messageAvatarsDecoded: report.dom.messages.filter(image => image.complete && image.naturalWidth > 0).length,
        consoleFailedToLoad: report.consoleFailedToLoad.length,
        // THE THREE SURFACES THIS PROBE NOW DRIVES, counted so a leg that stopped driving one cannot look
        // identical to a leg that drove it and found everything correct.
        personaPickerRows: report.dom.personaPicker?.rowCount ?? 0,
        personaPickerSelected: report.dom.personaPicker?.selectedAfterClick === true ? 1 : 0,
        backgroundTiles: report.dom.backgroundDriven?.gallery?.tiles ?? 0,
        swipedMessageAvatar: report.dom.swipedMessageAvatar?.after?.avatar?.naturalWidth > 0 ? 1 : 0,
    };
} catch (error) {
    report.failure = String(error?.stack ?? error).slice(0, 1200);
} finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

console.log(JSON.stringify({
    report: reportPath,
    subject: report.subject,
    countLoaded: report.countLoaded,
    failedImages: report.imageRequests.filter(entry => entry.status >= 400).map(entry => `${entry.status} ${entry.pathAndQuery}`),
    consoleFailedToLoad: report.consoleFailedToLoad.map(entry => entry.text).slice(0, 6),
    failure: report.failure ? report.failure.split('\n')[0] : null,
}, null, 2));

if (report.failure) process.exitCode = 1;
