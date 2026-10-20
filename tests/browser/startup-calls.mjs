// Startup-call enumeration: what does the pinned frontend ask for while booting, and which of those
// requests can BLOCK a send?
//
// This exists because four blocking routes were discovered one per turn by the generation probe. The
// probe's failure list tells you the current first blocker, not the whole set. This script turns the
// open-ended loop into a closed list.
//
// Classification, and the distinction matters more than the list:
//   - cosmetic      : image/stylesheet/font/media requests and the app's own cosmetic assets. They
//                     cannot block a send and a 404 on one is not a compatibility gap in a route.
//   - missing       : a non-cosmetic request that reached NO registered route (it fell through to the
//                     static SPA/404 handler). This is work to do, and the list is the work.
//   - misbehaving   : a request that DID reach a registered route and still answered an error. That is
//                     a bug in code we already have, and belongs in a different pile.
//
// Usage: node startup-calls.mjs [--report <path>]

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

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

async function waitFor(url, deadlineMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
        try {
            const response = await fetch(url);
            if (response.status < 500) {
                return;
            }
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${url} did not answer`);
}

const port = await freePort();
const dataRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-startup-'));
const binarySetting = process.env.GOTAVERN_BINARY ?? '';
const binary = binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
if (!binarySetting) {
    const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
    if (await new Promise(resolve => build.on('exit', resolve)) !== 0) {
        throw new Error('go build failed');
    }
}

const server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
let origin = `http://127.0.0.1:${port}`;
const observed = [];
const pageErrors = [];
let browser;
try {
    await waitFor(`${origin}/version`);
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => pageErrors.push(String(error.message ?? error).slice(0, 300)));
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== origin) {
            return;
        }
        observed.push({ method: request.method(), path: url.pathname + url.search, resourceType: request.resourceType(), status: null, contentType: '', markup: false });
    });
    page.on('response', async response => {
        const url = new URL(response.url());
        if (url.origin !== origin) {
            return;
        }
        const entry = [...observed].reverse().find(candidate => candidate.status === null && candidate.path === url.pathname + url.search && candidate.method === response.request().method());
        if (!entry) {
            return;
        }
        entry.status = response.status();
        entry.contentType = response.headers()['content-type'] ?? '';
        try {
            const body = await response.text();
            entry.markup = body.trimStart().startsWith('<');
        } catch {
            entry.markup = false;
        }
    });
    await page.goto(origin + '/');
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Drive one send: the blocking calls in this frontend happen during generation, not during load,
    // so a load-only enumeration reports a clean page and misses them. The provider is pointed at a
    // closed port on purpose: the calls under test are the frontend's own, so the send does not need to
    // succeed for them to appear.
    await page.evaluate(async () => {
        const script = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        await script.newAssistantChat({ temporary: true });
        script.chat.push({ name: 'User', is_user: true, is_system: false, mes: 'enumeration probe', extra: {} });
        await script.addOneMessage(script.chat.at(-1));
        oai_settings.chat_completion_source = 'custom';
        oai_settings.custom_url = 'http://127.0.0.1:1';
        oai_settings.custom_model = 'probe-model';
        oai_settings.stream_openai = false;
        try {
            await script.Generate('normal');
        } catch {
            // expected: the provider is unreachable; the calls are what we are counting.
        }
    });
    await new Promise(resolve => setTimeout(resolve, 4000));
} finally {
    if (browser) {
        await browser.close();
    }
}

// Ask the server directly whether a path is a registered route: an unregistered POST falls through to
// the static handler, which answers the SPA document (markup). A registered route answers its own body.
const indexBody = await (await fetch(`${origin}/`)).text().catch(() => '');
async function isRegistered(entry) {
    try {
        const response = await fetch(origin + entry.path, { method: entry.method });
        const body = await response.text();
        return body !== indexBody && body !== notFoundBody;
    } catch {
        return false;
    }
}

// Classification is by status semantics, not by comparing bodies: a body comparison depends on what
// the static handler happens to serve and flipped between probe revisions. GoTavern's unregistered
// paths answer 404 (or 405 for a wrong method); a REGISTERED route that fails answers 5xx.
const calls = [];
for (const entry of observed) {
    let classification;
    if (entry.resourceType === 'image' || entry.resourceType === 'stylesheet' || entry.resourceType === 'font' || entry.resourceType === 'media') {
        classification = 'cosmetic';
    } else if (entry.status === null) {
        classification = 'no-response';
    } else if (entry.status === 404 || entry.status === 405) {
        classification = 'missing';
    } else if (entry.status >= 400) {
        classification = 'misbehaving';
    } else {
        classification = 'ok';
    }
    calls.push({ ...entry, classification });
}
const ordering = { missing: 0, misbehaving: 1, cosmetic: 2, ok: 3 };
calls.sort((left, right) => (ordering[left.classification] - ordering[right.classification])
    || left.path.localeCompare(right.path));

const lines = [];
lines.push('# Frontend startup-call enumeration');
lines.push('');
lines.push(`GoTavern: \`gotavern start --port ${port} --dataRoot <scratch>\``);
lines.push(`Requests observed during page load: ${calls.length}. Page errors: ${pageErrors.length}.`);
lines.push('');
lines.push('Classification: `missing` reached no registered route (work to do), `misbehaving` reached a');
lines.push('registered route and still errored (a bug in code we have), `cosmetic` is an image, stylesheet,');
lines.push('font or media request that cannot block a send, and `ok` is a 2xx.');
lines.push('');
lines.push('| method | path | resource | status | classification |');
lines.push('| --- | --- | --- | --- | --- |');
for (const call of calls) {
    lines.push(`| ${call.method} | \`${call.path}\` | ${call.resourceType} | ${call.status ?? 'no response'} | ${call.classification} |`);
}
lines.push('');
const missing = calls.filter(call => call.classification === 'missing');
const misbehaving = calls.filter(call => call.classification === 'misbehaving');
lines.push(`## Blocking candidates: ${missing.length} missing, ${misbehaving.length} misbehaving`);
lines.push('');
for (const call of missing) {
    lines.push(`- ${call.method} \`${call.path}\` (${call.resourceType})`);
}
if (misbehaving.length === 0) {
    lines.push('');
    lines.push('No registered route answered an error during load.');
} else {
    lines.push('');
    for (const call of misbehaving) {
        lines.push(`- MISBEHAVING ${call.method} \`${call.path}\` answered ${call.status}`);
    }
}
lines.push('');
if (pageErrors.length > 0) {
    lines.push('## Page errors');
    lines.push('');
    for (const error of pageErrors) {
        lines.push(`- ${error}`);
    }
}

server.kill();
const reportPath = path.resolve(process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : path.join(repoRoot, 'docs', 'frontend-startup-calls.md'));
await fs.writeFile(reportPath, lines.join('\n') + '\n');
console.log(`missing=${missing.length} misbehaving=${misbehaving.length} cosmetic=${calls.filter(call => call.classification === 'cosmetic').length} ok=${calls.filter(call => call.classification === 'ok').length}`);
console.log(`report: ${reportPath}`);
process.exit(0);
