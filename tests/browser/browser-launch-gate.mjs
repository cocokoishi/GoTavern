// A REPO-WIDE SAFETY GATE: NO PROBE IN tests/browser/** MAY OPEN A DESKTOP BROWSER.
//
// WHY THIS EXISTS (2026-10-31, measured on the operator's desktop): the Q21 hand-back probe booted GoTavern
// with `--configPath <tree>/config.yaml` and no `--browserLaunchEnabled false`. The seeded config is the
// PINNED default, whose `browserLaunch.enabled` is TRUE (`upstream/default/config.yaml`; GoTavern gates the
// launch on it in `cmd/gotavern/browser.go`, pinned in `src/browserLaunch.js`), so every local run of that
// probe opened the user's DEFAULT BROWSER. The window is not a product defect; it is a probe defect, and the
// same omission existed in twelve other probe boot sites.
//
// It is cheap to prevent and expensive to notice: a server boot looks identical whether or not it opened a
// window (CI has no desktop, so CI can never see it), and the symptom is a complaint from a person, not a
// red run. Therefore this gate reads the harness source and REFUSES any server spawn whose argv does not
// disable the launch, and any Playwright launch that does not say `headless: true` explicitly.
//
// WHAT IT CHECKS, and nothing else:
//   1. every `spawn(...)` call whose argv contains the literal 'start' (a GoTavern server) or 'server.js'
//      (the pinned server) must contain `--browserLaunchEnabled` and `'false'` in the same call;
//   2. every Playwright browser launch call (chromium's launch and persistent-context forms) must pass
//      `headless: true` in its options.
//
// WHAT IT DOES NOT CHECK: a server spawned through a helper that is not a literal spawn call in this
// directory (the q20 shared helper `q20-leg-runtime.mjs` IS a literal spawn site and is covered), and a
// dynamically constructed argv the source cannot read. Those are the honest limits of a source gate; the
// requirement it enforces is the one whose absence cost the operator a desktop window.
//
// Usage: node tests/browser/browser-launch-gate.mjs [--json]
// Exit:  0 when clean, 1 when a violation exists (each printed as file:line: rule), 2 on a scan failure.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = here;

function sourceFiles(directory) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...sourceFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
            files.push(full);
        }
    }
    return files;
}

// Balanced-paren call extractor that is quote-aware, so an argv containing a ')' inside a string (a path, a
// JSON fragment, a regex) cannot truncate the call. Comments are not stripped: a commented-out server boot is
// reported rather than ignored, because a gate that skips comments is a gate a future reader can defeat by
// commenting a call in. Fixing the report means deleting the stale comment.
function callSites(text, callee) {
    const sites = [];
    const needle = `${callee}(`;
    let index = text.indexOf(needle);
    while (index >= 0) {
        const before = index === 0 ? '' : text[index - 1];
        if (/[A-Za-z0-9_$]/.test(before)) {
            index = text.indexOf(needle, index + 1);
            continue;
        }
        const open = index + needle.length - 1;
        let depth = 0;
        let inString = null;
        let escape = false;
        let i = open;
        for (; i < text.length; i += 1) {
            const char = text[i];
            if (escape) { escape = false; continue; }
            if (inString) {
                if (char === '\\') escape = true;
                else if (char === inString) inString = null;
                continue;
            }
            if (char === "'" || char === '"' || char === '`') { inString = char; continue; }
            if (char === '(') depth += 1;
            else if (char === ')') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        if (depth !== 0) throw new Error(`unbalanced ${callee}( starting at offset ${index}`);
        sites.push({
            index,
            args: text.slice(open + 1, i),
            line: text.slice(0, index).split('\n').length,
        });
        index = text.indexOf(needle, i + 1);
    }
    return sites;
}

const normalize = value => value.replace(/\s+/g, '');
const SERVER_SPAWN = /'start'|"start"|'server\.js'|"server\.js"/;

function audit(file) {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(root, file).split(path.sep).join('/');
    const violations = [];
    let serverSpawns = 0;
    let browserLaunches = 0;

    for (const site of callSites(text, 'spawn')) {
        if (!SERVER_SPAWN.test(site.args)) continue;
        serverSpawns += 1;
        const compact = normalize(site.args);
        const disablesLaunch = compact.includes("'--browserLaunchEnabled','false'")
            || compact.includes('"--browserLaunchEnabled","false"')
            || compact.includes('--browserLaunchEnabled,false');
        if (!disablesLaunch) {
            violations.push({ file: relative, line: site.line, rule: 'server-spawn-without-browserLaunchEnabled', excerpt: site.args.replace(/\s+/g, ' ').slice(0, 220) });
        }
    }

    for (const callee of ['chromium.launch', 'chromium.launchPersistentContext']) {
        for (const site of callSites(text, callee)) {
            browserLaunches += 1;
            if (!normalize(site.args).includes('headless:true')) {
                violations.push({ file: relative, line: site.line, rule: `${callee}-without-explicit-headless`, excerpt: site.args.replace(/\s+/g, ' ').slice(0, 220) });
            }
        }
    }
    return { file: relative, serverSpawns, browserLaunches, violations };
}

const report = { schemaVersion: 1, gate: 'browser-launch', files: 0, serverSpawns: 0, browserLaunches: 0, violations: [] };
try {
    const files = sourceFiles(root).sort();
    for (const file of files) {
        const result = audit(file);
        report.files += 1;
        report.serverSpawns += result.serverSpawns;
        report.browserLaunches += result.browserLaunches;
        report.violations.push(...result.violations);
    }
    report.verdict = report.violations.length === 0 ? 'clean' : 'violation';
    if (process.argv.includes('--json')) {
        console.log(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        for (const violation of report.violations) {
            console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.excerpt}`);
        }
        console.log(`browser-launch gate: ${report.verdict} -- ${report.serverSpawns} server spawn(s) and ${report.browserLaunches} browser launch(es) checked across ${report.files} file(s)`);
    }
    process.exit(report.violations.length === 0 ? 0 : 1);
} catch (error) {
    console.error(`browser-launch gate: SCAN FAILED -- ${String(error?.message ?? error)}`);
    process.exit(2);
}
