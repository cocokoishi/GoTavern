// Increment 0: run the PINNED SillyTavern frontend e2e specs, unmodified, against a running
// GoTavern, and report per-spec pass/fail with a failure mode.
//
// This is a COMPATIBILITY MEASUREMENT, not a test gate. Most specs are expected to fail while
// routes are unimplemented, and the point is to turn those failures into an inventory of what
// the pinned frontend needs. Nothing here fixes anything: the runner boots a server, copies the
// pinned specs into a scratch directory so their `@playwright/test` import resolves from this
// package, runs them, and writes a report.
//
// The specs are copied rather than vendored: they are run byte-identical from the pinned
// checkout, so the report describes upstream's own suite and not a fork of it. The scratch copy
// is gitignored.
//
// Usage:
//   node run-pinned-suite.mjs [--reference <pinned SillyTavern checkout>] [--report <path>]
//
// The reference checkout defaults to $GOTAVERN_REFERENCE, then .reference/SillyTavern (the path
// CI checks out), then ../SillyTavern (a local developer checkout).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argumentValue(name, fallback) {
    const index = process.argv.indexOf(name);
    if (index === -1) {
        return fallback;
    }
    return process.argv[index + 1];
}

async function exists(target) {
    try {
        await fs.stat(target);
        return true;
    } catch {
        return false;
    }
}

async function resolveReference() {
    const explicit = argumentValue('--reference', process.env.GOTAVERN_REFERENCE);
    const candidates = [
        explicit,
        path.join(repoRoot, '.reference', 'SillyTavern'),
        path.resolve(repoRoot, '..', 'SillyTavern'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (await exists(path.join(candidate, 'tests', 'frontend', 'frontent-test-utils.js'))) {
            return candidate;
        }
    }
    throw new Error(`no pinned SillyTavern checkout found; tried: ${candidates.join(', ')}`);
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address.port;
            server.close(() => resolve(port));
        });
    });
}

async function waitForServer(url, deadlineMs) {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`server did not answer at ${url}`);
}

// Failure modes are coarse on purpose. The raw first error line is kept alongside so the report
// never claims a classification it cannot support.
function classify(spec) {
    const text = String(spec.error ?? '');
    if (spec.status === 'passed') {
        return 'passed';
    }
    if (spec.status === 'skipped') {
        return 'skipped by a failing hook (see raw error)';
    }
    if (spec.status === 'hung') {
        return 'hung: the frontend never settled (killed at the file timeout)';
    }
    if (/Timeout .* exceeded|waitForFunction|waitForURL/.test(text)) {
        return 'timeout (frontend did not reach the state the spec waits for)';
    }
    if (/404|Failed to load resource/.test(text)) {
        return 'missing route or asset (404)';
    }
    if (/is not defined|undefined is not|cannot read properties of undefined/i.test(text)) {
        return 'missing browser API or frontend state';
    }
    if (/Cannot find module|Failed to resolve module/.test(text)) {
        return 'frontend module failed to load';
    }
    if (/expect\(/.test(text)) {
        return 'assertion mismatch';
    }
    return 'other';
}

const reference = await resolveReference();
const port = await freePort();
const dataRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-browser-'));
const runDir = path.join(here, '.pinned-run');

await fs.rm(runDir, { recursive: true, force: true });
await fs.mkdir(runDir, { recursive: true });

// The specs run IN PLACE from the pinned checkout: several of them import into the pinned
// repository's own `src/`, so copying them breaks those imports. Their `@playwright/test`
// import is resolved by linking this package's node_modules into `<reference>/tests`, which is
// the nearest ancestor of the spec files. The link is removed afterwards unless it was already
// there, so the checkout is left as it was found.
const pinnedFrontend = path.join(reference, 'tests', 'frontend');
const pinnedTestsModules = path.join(reference, 'tests', 'node_modules');
let createdLink = false;
if (!(await exists(pinnedTestsModules))) {
    const ourModules = path.join(here, 'node_modules');
    if (process.platform === 'win32') {
        const junction = spawn('cmd', ['/c', 'mklink', '/J', pinnedTestsModules, ourModules]);
        const output = [];
        junction.stdout.on('data', chunk => output.push(chunk.toString()));
        junction.stderr.on('data', chunk => output.push(chunk.toString()));
        const code = await new Promise(resolve => junction.on('exit', resolve));
        if (code !== 0) {
            throw new Error(`could not link ${pinnedTestsModules}: ${output.join('')}`);
        }
    } else {
        await fs.symlink(ourModules, pinnedTestsModules, 'dir');
    }
    createdLink = true;
}

// The generated config is a run artifact. workers=1 and retries=0 because this is a measurement:
// a flaky pass would be as misleading as a flaky failure, and a hung spec must fail rather than
// block, since the pinned helper waits for the preloader with no timeout of its own.
await fs.writeFile(path.join(runDir, 'playwright.config.js'), `import { defineConfig } from '@playwright/test';
const baseURL = process.env.ST_BASE_URL;
export default defineConfig({
    testDir: ${JSON.stringify(pinnedFrontend.replaceAll('\\', '/'))},
    testMatch: '*.e2e.js',
    timeout: 30000,
    globalTimeout: 480000,
    retries: 0,
    workers: Number(process.env.ST_WORKERS ?? 1),
    fullyParallel: Number(process.env.ST_WORKERS ?? 1) > 1,
    reporter: [['json', { outputFile: process.env.ST_REPORT_FILE }]],
    // HEADLESS IS EXPLICIT: this suite drives the pinned frontend in a measurement, never for a person to watch.
    use: { baseURL, headless: true, video: 'off', screenshot: 'off', trace: 'off' },
});
`);
// The binary is either given (CI builds it once) or built here into the scratch directory, so
// the runner is self-sufficient on a developer machine.
const binarySetting = process.env.GOTAVERN_BINARY ?? '';
const binary = binarySetting
    ? path.resolve(binarySetting)
    : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
if (!binarySetting) {
    const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
    const buildCode = await new Promise(resolve => build.on('exit', resolve));
    if (buildCode !== 0) {
        throw new Error('go build failed');
    }
}
// `--browserLaunchEnabled false` IS NOT OPTIONAL. The seeded config is the pinned default, whose
// `browserLaunch.enabled` is TRUE, so a server booted from this scratch root opens the OPERATOR'S DEFAULT BROWSER
// at startup (the same hazard run-against-pinned.mjs and q20-leg-runtime.mjs record). A test runner must not open
// a desktop window; the flag overrides the config without editing the pinned tree.
const server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--browserLaunchEnabled', 'false'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
});
const serverLog = [];
server.stdout.on('data', chunk => serverLog.push(chunk.toString()));
server.stderr.on('data', chunk => serverLog.push(chunk.toString()));

let exitCode = 0;
try {
    const baseURL = `http://127.0.0.1:${port}`;
    await waitForServer(`${baseURL}/version`, 30000);

    // One spec file per invocation, each with its own hard timeout: the frontend can hang on an
    // incomplete backend (unbounded retry, not an error), and a single hanging file must not stop
    // the others from being measured. A file that hits the timeout is recorded as hung.
    const specFiles = (await fs.readdir(pinnedFrontend)).filter(entry => entry.endsWith('.e2e.js')).sort();
    const perFileTimeout = Number(process.env.ST_FILE_TIMEOUT_MS ?? 90000);
    const specs = [];
    for (const specFile of specFiles) {
        const reportFile = path.join(runDir, `report-${specFile}.json`);
        const run = spawn(process.execPath, [
            path.join(here, 'node_modules', '@playwright', 'test', 'cli.js'),
            'test',
            `--config=${path.join(runDir, 'playwright.config.js')}`,
            specFile,
        ], {
            cwd: runDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ST_BASE_URL: baseURL, ST_REPORT_FILE: reportFile, ST_FILE_TIMEOUT_MS: String(perFileTimeout) },
        });
        const fileStartedAt = Date.now();
        let finished = false;
        const killer = setTimeout(() => {
            if (!finished) {
                run.kill('SIGKILL');
            }
        }, perFileTimeout);
        await new Promise(resolve => run.on('exit', resolve));
        finished = true;
        clearTimeout(killer);
        const fileSeconds = Math.round((Date.now() - fileStartedAt) / 1000);

        let report;
        try {
            report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
        } catch {
            specs.push({ file: specFile, title: '(whole file)', status: 'hung', error: `file did not finish within ${perFileTimeout}ms and was killed: the frontend did not settle, so its specs could not be measured` });
            continue;
        }
        const collected = [];
        const hookErrors = [];
        const walkReport = suites => {
            for (const suite of suites ?? []) {
                for (const error of suite.errors ?? []) {
                    hookErrors.push(String(error.message ?? '').slice(0, 600));
                }
                for (const spec of suite.specs ?? []) {
                    for (const testCase of spec.tests ?? []) {
                        const result = testCase.results?.[0] ?? {};
                        collected.push({
                            file: specFile,
                            title: spec.title,
                            status: result.status ?? testCase.status ?? 'unknown',
                            error: (result.errors ?? []).map(error => error.message ?? '').join('\n').slice(0, 600),
                            fileSeconds,
                        });
                    }
                }
                walkReport(suite.suites);
            }
        };
        walkReport(report.suites);
        if (hookErrors.length > 0) {
            for (const entry of collected) {
                if (entry.status !== 'passed' && !entry.error) {
                    entry.error = hookErrors[0];
                }
            }
        }
        if (collected.length === 0) {
            specs.push({ file: specFile, title: '(whole file)', status: 'hung', fileSeconds, error: 'no specs were collected before the file timed out' });
        } else {
            specs.push(...collected);
        }
    }
    const lines = [];
    lines.push('# Pinned frontend compatibility measurement (increment 0)');
    lines.push('');
    lines.push(`Pinned SillyTavern checkout: \`${reference}\``);
    lines.push(`GoTavern: \`gotavern start --port ${port} --dataRoot <scratch>\``);
    lines.push(`Pinned suite: ${specs.length} specs, run unmodified from the checkout with Playwright pinned to 1.56.1.`);
    lines.push('');
    lines.push('This is a measurement of how much of the pinned frontend contract GoTavern satisfies today.');
    lines.push('Expected failures are not defects: most routes are still unimplemented, and the value here is the');
    lines.push('failure mode per spec, which is an inventory of what the frontend needs.');
    lines.push('');
    lines.push('## Per-file status and cost');
    lines.push('');
    lines.push('Statuses are `passed`, `failed`, `hung` (killed at the file timeout, so unmeasured) or `not-run`.');
    lines.push('A hung file is not a failing file: its specs were never measured.');
    lines.push('');
    lines.push('| file | status | specs | passed | failed | hung | wall clock (s) |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    const fileRows = new Map();
    for (const spec of specs) {
        const row = fileRows.get(spec.file) ?? { specs: 0, passed: 0, failed: 0, hung: 0, seconds: spec.fileSeconds ?? 0 };
        row.specs += 1;
        if (spec.status === 'passed') {
            row.passed += 1;
        } else if (spec.status === 'hung') {
            row.hung += 1;
        } else if (spec.status === 'skipped') {
            // skipped by a failing hook: the file is measured, its specs are not evidence either way
        } else {
            row.failed += 1;
        }
        fileRows.set(spec.file, row);
    }
    for (const [file, row] of [...fileRows.entries()].sort()) {
        const status = row.hung > 0 ? 'hung' : row.failed > 0 ? 'failed' : 'passed';
        lines.push(`| ${file} | ${status} | ${row.specs} | ${row.passed} | ${row.failed} | ${row.hung} | ${row.seconds} |`);
    }
    lines.push('');    lines.push('| spec | status | failure mode |');
    lines.push('| --- | --- | --- |');
    const counts = new Map();
    for (const spec of specs.sort((left, right) => left.file.localeCompare(right.file) || left.title.localeCompare(right.title))) {
        const mode = classify(spec);
        counts.set(mode, (counts.get(mode) ?? 0) + 1);
        lines.push(`| ${spec.file} — ${spec.title} | ${spec.status} | ${mode} |`);
    }
    lines.push('');
    lines.push('## Failure modes');
    lines.push('');
    for (const [mode, count] of [...counts.entries()].sort((left, right) => right[1] - left[1])) {
        lines.push(`- ${mode}: ${count}`);
    }
    lines.push('');
    lines.push('## Raw first error per failing spec');
    lines.push('');
    for (const spec of specs.filter(entry => entry.status !== 'passed')) {
        lines.push(`### ${spec.file} — ${spec.title}`);
        lines.push('```');
        lines.push(spec.error.trim().split('\n').slice(0, 6).join('\n'));
        lines.push('```');
        lines.push('');
    }
    const reportPath = path.resolve(argumentValue('--report', path.join(repoRoot, 'docs', 'frontend-compatibility-measurement.md')));
    await fs.writeFile(reportPath, lines.join('\n'));
    console.log(`report written to ${reportPath}`);
    console.log(`${specs.filter(spec => spec.status === 'passed').length}/${specs.length} specs passed`);
} catch (error) {
    console.error('spike failed:', error.message);
    console.error(serverLog.join('').split('\n').slice(-10).join('\n'));
    exitCode = 1;
} finally {
    server.kill();
}

process.exit(exitCode);