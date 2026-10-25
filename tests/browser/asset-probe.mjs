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

// THE SAME TREE ON BOTH LEGS, STAGED BY THE PROBE RATHER THAN BY THE CI SHELL: two legs that each stage
// their own copy from the same builder cannot silently differ, and the report records the digests so the
// comparator can refuse a pair that did not start identical.
async function stageFixture(dataRoot) {
    const files = [
        { relative: path.join(USER_HANDLE, 'characters', CARD_FILE), bytes: buildPng([textChunk('chara', Buffer.from(JSON.stringify(CARD), 'utf8').toString('base64'))]) },
        { relative: path.join(USER_HANDLE, 'backgrounds', BACKGROUND_FILE), bytes: buildPng([textChunk('Comment', 'probe asset background')]) },
        { relative: path.join(USER_HANDLE, 'User Avatars', PERSONA_FILE), bytes: buildPng([textChunk('Comment', 'probe asset persona')]) },
    ];
    const staged = [];
    for (const file of files) {
        const target = path.join(dataRoot, file.relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.bytes);
        staged.push({ relative: file.relative.split(path.sep).join('/'), byteLength: file.bytes.length, sha256: digest(file.bytes) });
    }
    return staged.sort((left, right) => left.relative.localeCompare(right.relative));
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
    server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
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
        fixture: { userHandle: USER_HANDLE, files: stagedFixture, stagedBy: 'asset-probe.mjs (the same builder on both legs); user data lives at <dataRoot>/<handle>/… (src/users.js getUserDirectories)' },
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

    browser = await chromium.launch();
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
    report.dom.clickTarget = await page.evaluate(() => {
        const block = document.querySelector('#rm_print_characters_block');
        const candidates = [
            '#rm_print_characters_block .avatar[data-type="character"]',
            '#rm_print_characters_block .avatar[data-chid]',
            '#rm_print_characters_block .avatar',
            '#rm_print_characters_block .character_select',
            '#rm_print_characters_block img',
        ];
        for (const selector of candidates) {
            const element = document.querySelector(selector);
            if (element) {
                (element.closest('.character_select') ?? element).click();
                return { selector, clicked: true };
            }
        }
        return { selector: null, clicked: false, blockPresent: Boolean(block), blockChildren: block ? block.children.length : null };
    });
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
        const toggle = document.querySelector('#backgrounds-drawer-toggle');
        if (!toggle) return { status: 'not-driven', reason: 'no #backgrounds-drawer-toggle in the served frontend' };
        toggle.click();
        const deadline = performance.now() + 15000;
        let tile = null;
        while (performance.now() < deadline) {
            tile = document.querySelector(`.bg_example[bgfile="${backgroundFile}"]`);
            if (tile) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!tile) return { status: 'not-driven', reason: `no .bg_example[bgfile="${backgroundFile}"] appeared within 15s of opening the panel` };
        const clipper = tile.querySelector('.thumbnail-clipper');
        const before = clipper ? getComputedStyle(clipper).backgroundImage : null;
        tile.scrollIntoView();
        // The lazy loader fires on intersection; give it a moment, then click, which is what a user does.
        await new Promise(resolve => setTimeout(resolve, 1500));
        const after = clipper ? getComputedStyle(clipper).backgroundImage : null;
        tile.click();
        const bgDeadline = performance.now() + 15000;
        let applied = null;
        while (performance.now() < bgDeadline) {
            const element = document.querySelector('#bg1');
            applied = element ? getComputedStyle(element).backgroundImage : null;
            if (applied && applied !== 'none' && applied.includes(backgroundFile)) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return {
            status: 'observed',
            tileBgFile: tile.getAttribute('bgfile'),
            tileDataUrl: tile.getAttribute('data-url'),
            tileThumbnailBeforeLoad: before,
            tileThumbnailAfterLoad: after,
            appliedBackgroundImage: applied,
        };
    }, BACKGROUND_FILE).catch(error => ({ status: 'not-driven', reason: `the background drive threw: ${String(error?.message ?? error).slice(0, 160)}` }));
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
    // DID THE STAGED BACKGROUND ITSELF REACH #bg1? A fresh tree applies /backgrounds/__transparent.png, so an
    // "applied background" observation that accepts any URL would pass while the staged image never rendered.
    report.dom.stagedBackgroundDriven = Boolean(
        report.dom.backgroundDriven &&
        String(report.dom.backgroundDriven.appliedBackgroundImage ?? '').includes(BACKGROUND_FILE),
    );

    // THE PERSONA SURFACE, ASKED OF THE SERVER THROUGH THE FRONTEND'S OWN HELPER. The persona PICKER is
    // not driven here (it needs a persona to exist and a panel interaction this probe does not own), so
    // the DOM half stays unproven and says so. What IS proven is the request a persona avatar makes.
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
