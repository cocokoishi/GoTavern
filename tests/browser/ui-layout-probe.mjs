// UI LAYOUT — DOES A REAL USER'S SCREEN SHOW WHAT THE ORIGINAL SERVER'S SCREEN SHOWS?
//
// WHY THIS EXISTS, in one measurement. GOAL.md Q3-Q7 are "proven" on the grounds that every image DECODED
// (`complete && naturalWidth > 0`, no console failure, no HTTP failure). All of that is true and none of it
// says the picture is where a user can see it. The existing asset probe records a single viewport
// (`asset-probe.mjs:360`, `{width: 1280, height: 900}`) and never changes it, so nothing in this repository
// has ever asked whether a control a user needs is REACHABLE when the window is narrow -- a phone, a
// half-screened laptop, a browser with a sidebar open. That is the Q7 `partial` and the M3 "narrow viewport"
// line, and an image that decodes inside a container that is 0 px wide, clipped, or scrolled out of reach
// is a broken picture that every existing gate calls green.
//
// WHAT IT MEASURES, and it measures only what a user can observe:
//   * for a fixed set of controls the frontend renders, and for each viewport, the element's box, whether
//     it has a non-zero area, whether it is inside the document's scrollable area, and whether the point at
//     its own centre is topmost (i.e. the element is not covered by something else at that point);
//   * the number of pixels of horizontal overflow the document has;
//   * for each image surface, `complete`, `naturalWidth/Height` and the same reachability facts.
//
// WHAT IT DOES NOT DO:
//   * it does not reimplement the layout, patch CSS, or move the page before measuring. `page.setViewportSize`
//     is Playwright's own API and changes the window the way a user resizing does; nothing on the page is
//     touched;
//   * it does not judge "looks right". A green here means "reachable at this size", which is a NECESSARY
//     condition and never a sufficient one. `docs/` and the scorecard must not read it as visual parity;
//   * it does not compare screenshots. A pixel diff across two servers is a different instrument with its
//     own masks and its own controls, and pretending reachability is parity is the failure this file exists
//     to avoid.
//
// THE RESULT IS STILL A DIFFERENTIAL. Every observation is taken on BOTH subjects from the same driver at
// the same size, and the comparator requires them to AGREE -- so "both are broken in the same way" is
// reported as `equally unreachable`, which is a finding about the original server and NOT a pass. That
// distinction is the whole reason GOAL.md §15 says "both bad is not a backend difference".

import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { seedLegConfig } from './seed-leg-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const playwrightModule = await import('@playwright/test');
const { chromium } = playwrightModule;

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

const dataRoot = argumentValue('--data-root');
const reportPath = argumentValue('--report', path.join(here, 'ui-layout-leg.json'));
const subject = process.env.PROBE_BASE_URL ? 'pinned' : 'gotavern';

// THE SIZES ARE NAMED BECAUSE A NUMBER ALONE DOES NOT RECORD WHY IT WAS CHOSEN. 1280x900 is the existing
// asset probe's viewport, so agreement with that lane is checkable. 800x600 and 390x844 are a small laptop
// window and a phone; 320x568 is the narrowest width the reset CSS in the pinned frontend is written for.
const VIEWPORTS = [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'small-laptop', width: 800, height: 600 },
    { name: 'phone', width: 390, height: 844 },
    { name: 'narrowest', width: 320, height: 568 },
];

// THE CONTROLS. Each is a selector the pinned frontend itself renders and that a user must be able to
// press. A selector that does not exist on EITHER subject is recorded as `absent` and is NOT a failure of
// this lane -- but an element absent on one subject and present on the other IS, because that is a backend
// serving a different document.
const CONTROLS = [
    { name: 'send-button', selector: '#send_but' },
    { name: 'send-textarea', selector: '#send_textarea' },
    { name: 'options-flyout-button', selector: '#options_button' },
    { name: 'character-panel-toggle', selector: '#rightNavHolder' },
    { name: 'left-panel-toggle', selector: '#leftNavDrawerIcon' },
    { name: 'character-list', selector: '#rm_print_characters_block' },
    { name: 'chat-container', selector: '#chat' },
    { name: 'persona-button', selector: '#persona_button' },
];

// IMAGE SURFACES a user is meant to see. `naturalWidth` alone is not enough: an <img> can decode and sit
// inside a zero-height clipped parent.
const IMAGES = [
    { name: 'character-avatar', selector: '#rm_print_characters_block .avatar img' },
    { name: 'user-avatar', selector: '#user_avatar_block .avatar img' },
];

/**
 * Reachability facts for one element, using only facts the browser already computes.
 *
 * `elementFromPoint` is the browser's own hit test -- it is exactly the question "would a click land on
 * this element", so it is not a reimplementation of layout and it is not an approximation of it.
 */
async function describeElement(page, selector) {
    return page.evaluate(inner => {
        const element = document.querySelector(inner);
        if (!element) return { present: false };
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const box = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        // WHO IS ON TOP AT THE CENTRE, BY NAME. Run 40450382265 recorded `covered-at-centre` for EVERY control
        // on BOTH subjects at ALL four sizes -- a shape no real layout produces, because the send button and the
        // navigation toggles do not share a footprint. A verdict of "covered" with no coverer named is exactly
        // the unfalsifiable finding this project keeps paying for, so the element that intercepted the hit test
        // is recorded. A single full-screen node covering everything is a HARNESS state (something never went
        // away), not a layout observation, and the comparator now refuses it as such.
        const centreX = box.x + Math.floor(box.width / 2);
        const centreY = box.y + Math.floor(box.height / 2);
        const withinViewport = centreX >= 0 && centreY >= 0 && centreX < window.innerWidth && centreY < window.innerHeight;
        let topmost = null;
        let coveredBy = null;
        if (withinViewport) {
            const hit = document.elementFromPoint(centreX, centreY);
            topmost = hit ? (hit === element || element.contains(hit) || hit.contains(element)) : null;
            if (topmost === false && hit) {
                const describe = node => {
                    const id = node.id ? `#${node.id}` : '';
                    const classes = node.classList && node.classList.length ? `.${[...node.classList].slice(0, 3).join('.')}` : '';
                    const nodeRect = node.getBoundingClientRect();
                    return `${node.tagName.toLowerCase()}${id}${classes}[${Math.round(nodeRect.width)}x${Math.round(nodeRect.height)}@${Math.round(nodeRect.x)},${Math.round(nodeRect.y)}]`;
                };
                const chain = [];
                for (let node = hit, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) chain.push(describe(node));
                const hitRect = hit.getBoundingClientRect();
                coveredBy = {
                    chain,
                    // A NODE THAT SPANS THE WHOLE VIEWPORT is the shape of an overlay that never went away, and it
                    // is what makes "covered" uninformative rather than a finding.
                    coversViewport: hitRect.width >= window.innerWidth - 1 && hitRect.height >= window.innerHeight - 1,
                    pointerEvents: window.getComputedStyle(hit).pointerEvents,
                    opacity: window.getComputedStyle(hit).opacity,
                    zIndex: window.getComputedStyle(hit).zIndex,
                };
            }
        }
        return {
            present: true,
            box,
            display: style.display,
            visibility: style.visibility,
            visibilityHidden: style.visibility === 'hidden' || style.display === 'none',
            nonZeroArea: box.width > 0 && box.height > 0,
            withinViewport,
            topmost,
            coveredBy,
            // An element whose own scrollWidth overflows is clipped for someone even if its box is fine.
            contentOverflows: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
            // The horizontal distance the element extends past the right edge, which is what a user cannot
            // reach by vertical scrolling.
            overflowRight: Math.max(0, box.x + box.width - window.innerWidth),
        };
    }, selector);
}

async function describeDocument(page) {
    return page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        // DOCUMENT OVERFLOW is the one measurement that catches "the layout grew wider than the screen",
        // which pushes the send bar off the right edge without any single element looking wrong.
        scrollWidth: Math.max(document.documentElement?.scrollWidth ?? 0, document.body?.scrollWidth ?? 0),
        scrollHeight: Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0),
        horizontalOverflow: Math.max(
            0,
            Math.max(document.documentElement?.scrollWidth ?? 0, document.body?.scrollWidth ?? 0) - window.innerWidth,
        ),
    }));
}

async function describeImage(page, selector) {
    return page.evaluate(inner => {
        const image = document.querySelector(inner);
        if (!image) return { present: false };
        const rect = image.getBoundingClientRect();
        return {
            present: true,
            complete: image.complete === true,
            naturalWidth: image.naturalWidth ?? 0,
            naturalHeight: image.naturalHeight ?? 0,
            currentSrc: String(image.currentSrc ?? image.src ?? '').slice(0, 200),
            box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            nonZeroArea: rect.width > 0 && rect.height > 0,
        };
    }, selector);
}

async function waitForServer(baseURL, deadlineMs = 120000) {
    const deadline = Date.now() + deadlineMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseURL}/version`);
            if (response.ok) return true;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${baseURL} never answered: ${String(lastError?.message ?? lastError)}`);
}

// The product's own boot, mirroring tests/browser/asset-probe.mjs so there is one way to start it and not
// two. `GOTAVERN_BINARY` is what CI sets; the `go build` fallback exists only for a developer running this by
// hand, and it is not reachable in CI because the variable is always set there.
let startedServer = null;
async function bootProduct() {
    const port = await freePort();
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    let binary = binarySetting;
    if (!binary) {
        binary = path.join(repoRoot, '.browser-bin', process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
        await new Promise((resolve, reject) => {
            const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
            build.on('exit', code => (code === 0 ? resolve() : reject(new Error(`go build exited ${code}`))));
            build.on('error', reject);
        });
    }
    const child = spawn(path.resolve(binary), [
        'start',
        '--port', String(port),
        '--dataRoot', dataRoot,
        '--configPath', path.join(dataRoot, 'config.yaml'),
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    // THE OUTPUT IS DRAINED AND KEPT, NOT DISCARDED: a product that fails to start must be diagnosable from
    // the run, and a silent pipe is how a startup defect becomes "the leg failed to drive".
    const output = [];
    child.stdout.on('data', chunk => output.push(String(chunk)));
    child.stderr.on('data', chunk => output.push(String(chunk)));
    child.on('exit', code => {
        if (code !== 0 && code !== null) output.push(`[product exited ${code}]`);
    });
    startedServer = { child, output };
    const url = `http://127.0.0.1:${port}`;
    try {
        await waitForServer(url);
    } catch (error) {
        throw new Error(`${String(error?.message ?? error)}; product output: ${output.join('').slice(-1500)}`);
    }
    return url;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function main() {
    // BOTH SUBJECTS BOOT THEIR OWN SERVER, THE WAY THE ASSET LEG DOES. The first version expected
    // PROBE_BASE_URL (which `run-against-pinned.mjs` supplies for the pinned half) or an explicit
    // `--base-url`, and on the GoTavern leg neither exists: the step runs the probe directly, so the probe
    // threw `PROBE_BASE_URL or --base-url is required`, the record step counted a drive failure, and the
    // comparator refused to judge. Run 40448807460. The pinned leg passed the whole time, which is what a
    // leg-specific harness defect looks like from the outside: one subject recorded, one refused.
    //
    // The boot below mirrors tests/browser/asset-probe.mjs:273-301 rather than inventing a second way to
    // start the product, and it honours GOTAVERN_BINARY so CI uses the binary the workflow built.
    let server = null;
    let baseURL = process.env.PROBE_BASE_URL ?? argumentValue('--base-url') ?? process.env.CAPTURE_BASE_URL;
    if (!baseURL) {
        if (subject !== 'gotavern') throw new Error('the pinned leg must be given PROBE_BASE_URL by run-against-pinned.mjs');
        baseURL = await bootProduct();
        server = startedServer;
    }
    if (!dataRoot) throw new Error('--data-root is required');

    const report = {
        probe: 'ui-layout',
        subject,
        baseURL,
        // A LEG THAT DID NOT DRIVE MUST NOT READ AS AGREEMENT. `drove` is asserted by the comparator.
        drove: false,
        viewports: VIEWPORTS,
        controls: CONTROLS.map(control => control.name),
        images: IMAGES.map(image => image.name),
        observations: [],
        pageErrors: [],
        consoleFailedToLoad: [],
        httpFailures: [],
        failure: null,
    };

    let browser;
    try {
        // THE TREE IS SEEDED BY THE LEG THAT OWNS IT. The GoTavern half seeds through seedLegConfig; the
        // pinned half gets the same document from run-against-pinned.mjs. Staging the card is the caller's
        // job (the workflow stages the same fixture into both trees) so this probe never writes a fixture
        // it did not derive.
        if (subject === 'gotavern') await seedLegConfig(dataRoot);
        await waitForServer(baseURL);

        browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height } });
        page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
        page.on('console', message => {
            const text = String(message.text()).slice(0, 300);
            if (/Failed to load resource/i.test(text)) report.consoleFailedToLoad.push(text);
        });
        page.on('requestfailed', request => {
            report.httpFailures.push({ url: String(request.url()).slice(0, 160), error: String(request.failure()?.errorText ?? '').slice(0, 80) });
        });
        // THE EXTERNAL CDN IS BLOCKED ON BOTH SUBJECTS. The pinned frontend loads a font/JS bundle from a CDN
        // in some configurations; letting one subject reach it and not the other would make the two legs
        // differ for a reason that is not the backend under test.
        await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
        // READINESS IS THE PRODUCT'S OWN SIGNAL, the same one every other browser leg waits for.
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });

        for (const viewport of VIEWPORTS) {
            // FROM THE SAME PAGE, by resizing: a fresh `goto` per size would make a reload-with-layout
            // difference look like a layout difference.
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            // ONE ANIMATION FRAME PLUS A SHORT SETTLE, bounded and named: the frontend transitions panels,
            // and measuring mid-transition would record a tween instead of a layout.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.waitForTimeout(250);

            const observation = {
                viewport: viewport.name,
                document: await describeDocument(page),
                controls: {},
                images: {},
            };
            for (const control of CONTROLS) {
                observation.controls[control.name] = await describeElement(page, control.selector);
            }
            for (const image of IMAGES) {
                observation.images[image.name] = await describeImage(page, image.selector);
            }
            report.observations.push(observation);
        }

        report.drove = report.observations.length === VIEWPORTS.length
            && report.observations.every(observation => observation.document.innerWidth > 0);
    } catch (error) {
        report.failure = String(error?.message ?? error).slice(0, 500);
    } finally {
        if (browser) await browser.close();
        // THE SERVER THIS PROBE STARTED IS STOPPED BY THIS PROBE. A leaked product process holds the port and
        // keeps the job's teardown waiting, and it also makes a later leg's failure ambiguous.
        if (server?.child) server.child.kill('SIGTERM');
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`${reportPath}\n`);
    }
    if (report.failure) process.exitCode = 1;
}

// THE MODULE ALSO HAS TO BE USABLE AS A LIBRARY, because the comparator imports nothing from it and the
// workflow drives it as a program. Running main() on import would boot a browser inside `node --check`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}

export { VIEWPORTS, CONTROLS, IMAGES };
