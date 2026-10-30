// ONE LEG OF THE EXTENSION ASSET-SERVING SURFACE: install the synthetic third-party extension, then fetch EVERY URL the
// pinned frontend builds for it and record status, content-type, byte length and sha256.
//
// THE QUESTION THIS ANSWERS, in the release gap's own words: "a manifest or module the host serves wrongly makes an
// installed extension appear dead with no error the user can act on". The deep canary legs prove the iframe/bridge path;
// they do not prove that `index.js` arrives as JavaScript rather than as an HTML error page. So this leg records exactly
// the three observations a browser acts on, and the comparator requires them to be EQUAL across the two subjects.
//
// BOTH SUBJECTS, ONE DRIVE. Run with no PROBE_BASE_URL, the leg boots GoTavern itself from GOTAVERN_BINARY over
// `--data-root` (the same boot shape `extension-probe.mjs` uses). Run under `run-against-pinned.mjs`, `PROBE_BASE_URL` is
// present and the leg must NOT boot anything: it installs the fixture into the caller-supplied `--data-root` and fetches
// the pinned server that is already listening. `bootSubject` refuses the contradictory combination (an external base URL
// AND a boot request) rather than silently comparing two different servers.
//
// WHY THE FIXTURE IS INSTALLED AFTER THE SUBJECT BOOTS. Pinned scans the extensions directory per request
// (`src/endpoints/extensions.js:480-533`) and stats each requested file per request (`src/users.js:1092-1120`), so an
// install that happens after boot is served exactly like one that happened before -- and installing it in each leg means
// each leg records the FIXTURE DIGESTS IT INSTALLED, which the comparator uses to prove the subject served THOSE bytes
// rather than something else that happened to answer 200.
//
// WHAT IS DELIBERATELY NOT HERE: no browser. This surface is about bytes the server sends; the module graph, the DOM and
// the helper bridge belong to the canary legs, and a probe that does not need a browser cannot be affected by one.
//
// Usage:
//   GOTAVERN_BINARY=<path> node tests/browser/extension-assets-probe.mjs --data-root <dir> --report <file> \
//       --subject gotavern --layout flat [--omit-module]
//   node tests/browser/run-against-pinned.mjs extension-assets-probe.mjs -- --data-root <dir> --report <file> \
//       --subject pinned --layout flat
//
// Exit 0 only when every step held and the leg's own judge ran; 2 on a refusal (a missing binary, a missing report path);
// 1 on a red step.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { seedLegConfig } from './seed-leg-config.mjs';
import { DISCRIMINATOR_FILE, EXTENSION_DIR, FIXTURE_FILES, MISSING_MODULE_DIR, installFixture, sha256, urlsFor } from './extension-assets-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

const external = Boolean(process.env.PROBE_BASE_URL);
const subject = argumentValue('--subject', external ? 'pinned' : 'gotavern');
const layout = argumentValue('--layout', 'flat');
const reportPath = path.resolve(argumentValue('--report', path.join(here, `extension-assets-${subject}.json`)));
const dataRoot = argumentValue('--data-root', null);
// THE DISCRIMINATOR IS THE LEG'S OWN IDENTITY, and it must be UNIQUE PER SUBJECT so the comparator can prove it is
// comparing two different runs and that each subject really served its own stamp.
const discriminator = argumentValue('--discriminator', `${subject}-${process.pid}-${Date.now()}`);

const report = {
    schemaVersion: 1,
    surface: 'extension-asset-serving',
    question: 'Does an installed third-party extension\'s manifest, module, stylesheet, locale and nested assets arrive with the same status, content-type and bytes from both servers?',
    subject,
    external,
    layout,
    startedAt: new Date().toISOString(),
    steps: [],
    assets: [],
    discriminator: { value: discriminator, file: DISCRIMINATOR_FILE, served: null },
    discovery: null,
    pageErrors: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail === null ? 'failed' : (typeof detail === 'string' ? detail : JSON.stringify(detail))}`;
    return ok;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.unref();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

async function waitForVersion(baseURL, deadlineMs = 120000) {
    const deadline = Date.now() + deadlineMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseURL}/version`);
            if (response.ok) return true;
            lastError = `HTTP ${response.status}`;
        } catch (error) {
            lastError = String(error?.message ?? error);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${baseURL}/version did not answer within ${deadlineMs} ms (last: ${lastError})`);
}

// The boot shape of the other browser legs: the subject's own binary, its own data root, the pinned default config.
function bootSubject({ root, port }) {
    const binarySetting = process.env.GOTAVERN_BINARY;
    if (!binarySetting) {
        console.error('REFUSING: GOTAVERN_BINARY is required to boot the GoTavern subject; without it this leg can only be the pinned half and the pair would compare one server with itself');
        process.exit(2);
    }
    if (!existsSync(binarySetting)) {
        console.error(`REFUSING: GOTAVERN_BINARY points at ${binarySetting}, which does not exist`);
        process.exit(2);
    }
    const server = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', root, '--configPath', path.join(root, 'config.yaml')], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = [];
    const keep = chunk => {
        tail.push(chunk.toString());
        while (tail.length > 120) tail.shift();
    };
    server.stdout.on('data', keep);
    server.stderr.on('data', keep);
    return { server, output: () => tail.join('').slice(-3000) };
}

// ONE FETCH, RECORDED THE WAY THE COMPARATOR COMPARES IT: the status, the content type EXACTLY as sent (charset
// included), the body length and the body digest. `bodyStartsWithHtml` is recorded because the negative case's whole
// point is that a missing module must NOT come back as a 200 carrying an HTML document.
async function fetchAsset(baseURL, entry) {
    const url = `${baseURL}${entry.path}`;
    try {
        const response = await fetch(url, { redirect: 'manual' });
        const body = Buffer.from(await response.arrayBuffer());
        return {
            path: entry.path,
            url,
            class: entry.class,
            justification: entry.justification,
            status: response.status,
            contentType: response.headers.get('content-type'),
            contentLengthHeader: response.headers.get('content-length'),
            byteLength: body.length,
            sha256: sha256(body),
            bodyStartsWithHtml: /^\s*<(?:!doctype|html|head|body)/i.test(body.subarray(0, 64).toString('latin1')),
            bodyPrefix: body.subarray(0, 60).toString('latin1').replace(/[\r\n\t]/g, ' '),
        };
    } catch (error) {
        return {
            path: entry.path,
            url,
            class: entry.class,
            justification: entry.justification,
            status: null,
            contentType: null,
            contentLengthHeader: null,
            byteLength: null,
            sha256: null,
            fetchError: String(error?.message ?? error),
        };
    }
}

async function run() {
    if (external && argumentValue('--boot', null) === 'yes') {
        console.error('REFUSING: PROBE_BASE_URL is set (this leg is the pinned half) and it was also asked to boot a subject; one leg must be one subject');
        process.exit(2);
    }
    if (!dataRoot) {
        console.error('REFUSING: --data-root is required, because this leg installs the extension fixture into the tree the subject serves and records the fixture digests it installed');
        process.exit(2);
    }
    await fs.mkdir(dataRoot, { recursive: true });

    // THE INSTALL IS THE INPUT, SO IT HAPPENS FIRST AND IS RECORDED BEFORE ANY REQUEST.
    const installed = installFixture({ dataRoot, layout, discriminator });
    report.fixture = {
        extensionDir: EXTENSION_DIR,
        missingModuleDir: MISSING_MODULE_DIR,
        layout: installed.layout,
        extensionRoot: path.relative(dataRoot, installed.extensionRoot).split(path.sep).join('/'),
        written: installed.written,
        missingManifest: installed.missingManifest,
        discriminatorFile: DISCRIMINATOR_FILE,
        discriminatorBytes: installed.written[DISCRIMINATOR_FILE]?.sha256 ?? null,
    };
    step('fixtureInstalled',
        Object.keys(installed.written).length === Object.keys(FIXTURE_FILES).length + 1,
        { files: Object.keys(installed.written), note: 'one extra file is the per-subject discriminator' });

    let baseURL;
    let server = null;
    if (!external) {
        const port = await freePort();
        baseURL = `http://127.0.0.1:${port}`;
        const legConfig = await seedLegConfig(dataRoot);
        report.legConfig = legConfig;
        const booted = bootSubject({ root: dataRoot, port });
        server = booted.server;
        try {
            await waitForVersion(baseURL);
        } catch (error) {
            throw new Error(`${error.message}; subject output: ${booted.output()}`);
        }
    } else {
        baseURL = String(process.env.PROBE_BASE_URL).replace(/\/$/, '');
    }
    report.baseURL = baseURL;
    step('subjectReady', true, { external });

    // THE DISCOVERY ANSWER IS THE ORACLE FOR THE NAME, not a string this probe invented: pinned builds the name as
    // `third-party/<folder>` for a user-directory extension (src/endpoints/extensions.js:514-518).
    const discovery = await fetchAsset(baseURL, { path: '/api/extensions/discover', class: 'discovery', justification: 'public/scripts/extensions.js:300' });
    report.discovery = { status: discovery.status, contentType: discovery.contentType, byteLength: discovery.byteLength, sha256: discovery.sha256 };
    let discovered = null;
    try {
        const response = await fetch(`${baseURL}/api/extensions/discover`);
        discovered = response.ok ? await response.json() : null;
    } catch {
        discovered = null;
    }
    const listed = Array.isArray(discovered) ? discovered : [];
    const localEntries = listed.filter(entry => entry && entry.type === 'local').map(entry => entry.name).sort();
    report.discovery.entries = { total: listed.length, local: localEntries };
    const wantedNames = [`third-party/${EXTENSION_DIR}`, `third-party/${MISSING_MODULE_DIR}`];
    step('discoverListsTheFixture',
        wantedNames.every(name => localEntries.includes(name)),
        { wanted: wantedNames, local: localEntries });

    // THE URL SET: pinned source shapes first (`urlsFor`), plus the discriminator file the leg itself installed.
    const urlSet = [
        ...urlsFor({ manifest: JSON.parse(FIXTURE_FILES['manifest.json'].content) }),
        { path: `/scripts/extensions/third-party/${EXTENSION_DIR}/${DISCRIMINATOR_FILE}`, class: 'discriminator', justification: 'a file the leg installs, fetched through the subject to prove WHICH subject served this leg' },
    ];
    for (const entry of urlSet) {
        report.assets.push(await fetchAsset(baseURL, entry));
    }

    // THE NEGATIVE CASE, on its own extension folder: manifest present, module absent.
    const negativeEntries = [
        { path: `/scripts/extensions/third-party/${MISSING_MODULE_DIR}/manifest.json`, class: 'negative-manifest', justification: 'public/scripts/extensions.js:543 (the manifest IS fetched, so the extension is listed)' },
        { path: `/scripts/extensions/third-party/${MISSING_MODULE_DIR}/${JSON.parse(FIXTURE_FILES['manifest.json'].content).js}`, class: 'negative-module', justification: 'public/scripts/extensions.js:819 (the module the manifest declares, and the file is missing)' },
    ];
    report.negative = [];
    for (const entry of negativeEntries) {
        report.negative.push(await fetchAsset(baseURL, entry));
    }

    // ---- the leg's own assertions -------------------------------------------------------------------------------
    const byPath = new Map(report.assets.map(asset => [asset.path, asset]));
    const expectedPaths = urlSet.map(entry => entry.path);
    step('everyAssetAnswered',
        expectedPaths.every(candidate => byPath.get(candidate)?.status !== null),
        report.assets.filter(asset => asset.status === null).map(asset => ({ path: asset.path, error: asset.fetchError })));

    const servedFromFixture = expectedPaths
        .filter(candidate => !candidate.endsWith(`/${DISCRIMINATOR_FILE}`))
        .every(candidate => {
            const asset = byPath.get(candidate);
            const relative = candidate.slice(candidate.indexOf(`/${EXTENSION_DIR}/`) + EXTENSION_DIR.length + 2);
            const expected = installed.written[relative];
            return expected !== undefined && asset?.status === 200 && asset.sha256 === expected.sha256 && asset.byteLength === expected.bytes;
        });
    report.servedFromFixture = expectedPaths.map(candidate => {
        const asset = byPath.get(candidate);
        const relative = candidate.slice(candidate.indexOf(`/${EXTENSION_DIR}/`) + EXTENSION_DIR.length + 2);
        return {
            path: candidate,
            expected: installed.written[relative] ?? null,
            observed: asset === undefined ? null : { status: asset.status, byteLength: asset.byteLength, sha256: asset.sha256 },
        };
    });
    step('servedBytesAreTheFixtureBytes', servedFromFixture, report.servedFromFixture.filter(entry => JSON.stringify(entry.expected) !== JSON.stringify(entry.observed)));

    const discriminatorAsset = byPath.get(`/scripts/extensions/third-party/${EXTENSION_DIR}/${DISCRIMINATOR_FILE}`);
    const discriminatorServed = discriminatorAsset?.status === 200
        && discriminatorAsset.sha256 === installed.written[DISCRIMINATOR_FILE]?.sha256;
    report.discriminator.served = discriminatorAsset === undefined ? null : {
        status: discriminatorAsset.status,
        byteLength: discriminatorAsset.byteLength,
        sha256: discriminatorAsset.sha256,
        expectedSha256: installed.written[DISCRIMINATOR_FILE]?.sha256 ?? null,
        value: discriminator,
    };
    step('discriminatorServedByThisSubject', discriminatorServed, report.discriminator.served);

    // THE FAILURE THE ROW NAMES: a listed extension whose module is missing must answer a DIAGNOSABLE status, never a 200
    // carrying HTML (a module script fed `text/html` fails with "Unexpected token '<'" and the user gets no actionable
    // error). Pinned's answer here is `sendStatus(404)` from the route's last line (src/users.js:1115).
    const negativeManifest = report.negative.find(entry => entry.class === 'negative-manifest');
    const negativeModule = report.negative.find(entry => entry.class === 'negative-module');
    const diagnosable = negativeModule?.status === 404
        && negativeModule?.bodyStartsWithHtml !== true
        && typeof negativeModule?.contentType === 'string'
        && !/^text\/html/i.test(negativeModule.contentType);
    step('missingModuleIs404NotHtml', diagnosable, {
        manifest: negativeManifest === undefined ? null : { status: negativeManifest.status, contentType: negativeManifest.contentType },
        module: negativeModule === undefined ? null : { status: negativeModule.status, contentType: negativeModule.contentType, byteLength: negativeModule.byteLength, bodyStartsWithHtml: negativeModule.bodyStartsWithHtml, bodyPrefix: negativeModule.bodyPrefix },
        why: 'pinned answers sendStatus(404) for a file that is not in the user directory nor the global fallback (src/users.js:1092-1120, the 404 at :1115); a 200 with an HTML body here is the "extension silently dead" failure',
    });

    if (server) server.kill();
}

// -----------------------------------------------------------------------------------------------------------------
// THE LEG'S JUDGE, so a report cannot exist without counting what it observed: a leg that fetched nothing has no
// business being compared, and the comparator refuses a report whose judge did not execute.
function judge(state) {
    const required = [
        'fixtureInstalled', 'subjectReady', 'discoverListsTheFixture', 'everyAssetAnswered',
        'servedBytesAreTheFixtureBytes', 'discriminatorServedByThisSubject', 'missingModuleIs404NotHtml',
    ];
    const byName = new Map(state.steps.map(entry => [entry.name, entry]));
    const missing = required.filter(name => !byName.has(name));
    const failed = state.steps.filter(entry => !entry.ok).map(entry => entry.name);
    const counts = {
        steps: state.steps.length,
        ok: state.steps.filter(entry => entry.ok).length,
        required: required.length,
        assetsFetched: state.assets.filter(asset => asset.status !== null).length,
        assetsAnswered200: state.assets.filter(asset => asset.status === 200).length,
        bytesMatchedFixture: (state.servedFromFixture ?? []).filter(entry => entry.expected !== null && entry.observed !== null && entry.expected.sha256 === entry.observed.sha256).length,
        discriminatorServed: state.discriminator?.served?.status === 200 ? 1 : 0,
        negativeDiagnosable: (state.negative ?? []).some(entry => entry.status === 404) ? 1 : 0,
    };
    const nonZero = counts.assetsFetched > 0 && counts.assetsAnswered200 >= 5 && counts.bytesMatchedFixture >= 5 && counts.discriminatorServed === 1;
    const verdict = missing.length > 0 ? 'unreached' : ((failed.length > 0 || !nonZero) ? 'mismatch' : 'match');
    return { executed: true, subject: state.subject, verdict, required: required.length, missing, failed, countsAreNonZero: nonZero, counts };
}

try {
    await run();
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    report.judge = judge(report);
    if (report.judge.verdict !== 'match') {
        report.failure = report.failure ?? `extension-assets judge ${report.judge.verdict}: failed=[${report.judge.failed.join(', ')}] missing=[${report.judge.missing.join(', ')}] counts=${JSON.stringify(report.judge.counts)}`;
    }
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${subject} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`${subject} judge: ${report.judge.verdict} -- ${report.judge.counts.ok}/${report.judge.counts.steps} step(s) green, counts=${JSON.stringify(report.judge.counts)}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
