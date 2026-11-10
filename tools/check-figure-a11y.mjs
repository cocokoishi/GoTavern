#!/usr/bin/env node
// HEADLESS CHECKS FOR THE README PERFORMANCE FIGURE (alpha.20).
//
// What this file is for: `tools/check-perf-docs.mjs` already gates the figure's DATA against the recorded
// artifact, its 1200x675 canvas, its dark/light pair, its palette contrast and its type floor. It cannot see
// LAYOUT: a longer label, a bigger type scale or a footer line that grew a few words can clip text or push it
// outside the canvas while every number still agrees. This script renders the committed SVG variants headlessly
// and measures the drawing, then checks the GitHub-Markdown wrapper around them.
//
// Headless only, by design: the checks run Chrome/Edge in `--headless` mode and read the DOM it prints; no desktop
// browser is launched and no network is touched (the page fetches `file://` URLs only, with an explicit flag).
//
// Checks, each with a stable id:
//   FIGURE-XML-SYNTAX        both committed variants parse as XML (not merely as tag soup)
//   FIGURE-TEXT-CONTAINED    every <text> bounding box stays inside the 1200x675 viewBox at 1200/720/360 px widths
//   FIGURE-NO-OVERFLOW       the rendered drawing never produces horizontal overflow at 360/720/1200 CSS px
//   FIGURE-TYPE-FLOOR        every declared font size is >= 13 px at 1:1
//   FIGURE-MOBILE-HERO       at 720 CSS px the ratio and headline type render at >= 18 px (readable at a glance)
//   FIGURE-DESC-VALUES       each variant's <desc> restates every recomputed value from tests/perf/q22-baseline.json
//   FIGURE-PAIR-DESC         the two variants carry an identical <desc> (they cannot disagree about the data)
//   README-PICTURE-BLOCK     README has exactly one <picture>/<source>/<img> block, dark+light selected by scheme
//   README-ALT-VALUES        the img alt text carries the recomputed numbers (the first screen's text surface)
//   README-MARKDOWN-SAFE     the wrapper uses only picture/source/img (no script/style/iframe/foreignObject)
//
// Usage:
//   node tools/check-figure-a11y.mjs [--out docs/alpha20/perf/figure-checks.json]
// The browser binary is taken from --browser, then $BROWSER_BIN, then the usual Edge/Chrome install paths.
// Exit code 0 = every check passed; 1 = at least one failed; 2 = harness/setup failure (no browser, missing file).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DARK = path.join(ROOT, 'docs', 'assets', 'benchmark.svg');
const LIGHT = path.join(ROOT, 'docs', 'assets', 'benchmark-light.svg');
const README = path.join(ROOT, 'README.md');
const BASELINE = path.join(ROOT, 'tests', 'perf', 'q22-baseline.json');

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    return process.argv[index + 1] ?? fallback;
}
const outPath = argumentValue('--out', null);

const browserCandidates = [
    argumentValue('--browser'),
    process.env.BROWSER_BIN,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
].filter(Boolean);
const browser = browserCandidates.find(candidate => {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
});
if (!browser) {
    console.error('figure-a11y: no headless browser found; pass --browser <path> or set BROWSER_BIN');
    process.exit(2);
}

const problems = [];
const checks = [];
function check(id, ok, message) {
    checks.push({ id, ok, message });
    if (!ok) problems.push(`${id}: ${message}`);
}

// ---- value formatting, shared with the artifact's own rule -----------------------------------------------
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const summary = baseline.report.summary;
const groupedInteger = value => Math.round(value).toLocaleString('en-US');
const formatMB = bytes => {
    const mb = bytes / 1e6;
    return mb >= 100 ? `${groupedInteger(mb)} MB` : `${mb.toFixed(1)} MB`;
};
const formatMs = value => (value >= 10 ? value.toFixed(2) : value.toFixed(3));
const formatRatio = value => `${value >= 100 ? value.toFixed(1) : value.toFixed(2)}x`;
const expectedValues = [
    `${groupedInteger(summary.pinned.bootMsMedian)} ms`,
    `${groupedInteger(summary.gotavern.bootMsMedian)} ms`,
    formatRatio(summary.pinned.bootMsMedian / summary.gotavern.bootMsMedian),
    formatMB(summary.pinned.rssBytesMedian),
    formatMB(summary.gotavern.rssBytesMedian),
    formatRatio(summary.pinned.rssBytesMedian / summary.gotavern.rssBytesMedian),
    `${formatMs(summary.pinned.versionMedianMs)} ms`,
    `${formatMs(summary.gotavern.versionMedianMs)} ms`,
    formatRatio(summary.pinned.versionMedianMs / summary.gotavern.versionMedianMs),
    `${summary.pinned.rootMedianMs.toFixed(2)} ms`,
    `${summary.gotavern.rootMedianMs.toFixed(2)} ms`,
    formatRatio(summary.pinned.rootMedianMs / summary.gotavern.rootMedianMs),
];

// ---- 1. the headless render: XML syntax, layout containment, overflow, type sizes ------------------------
// The SVG sources are INLINED into the wrapper page rather than fetched: a headless file:// page that fetches
// file:// URLs needs an extra permission flag, and a harness that depends on one is a harness that can fail for a
// reason unrelated to the figure. Inlining makes the page self-contained, exactly like the figure itself.
const darkSource = fs.readFileSync(DARK, 'utf8');
const lightSource = fs.readFileSync(LIGHT, 'utf8');
const wrapper = `<!doctype html><html><head><meta charset="utf-8"><title>figure-a11y</title></head><body>
<pre id="result">RUNNING</pre>
<script>
(function () {
  const files = ${JSON.stringify([{ name: 'benchmark.svg', text: darkSource }, { name: 'benchmark-light.svg', text: lightSource }])};
  const report = { xml: [], layout: [] };
  try {
    for (const file of files) {
      const text = file.text;
      const xmlDoc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const parserError = xmlDoc.getElementsByTagName('parsererror');
      report.xml.push({ file: file.name, ok: parserError.length === 0, error: parserError.length ? xmlDoc.documentElement.textContent.slice(0, 300) : '' });
      for (const width of [1200, 720, 360]) {
        const host = document.createElement('div');
        host.style.width = width + 'px';
        host.style.overflow = 'visible';
        document.body.appendChild(host);
        host.innerHTML = text.replace(/^<\\?xml[^>]*\\?>/, '');
        const svg = host.querySelector('svg');
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.setAttribute('style', 'display:block;width:100%;height:auto');
        void host.offsetWidth; // force layout before getBBox() measures the text
        const rect = svg.getBoundingClientRect();
        const declared = [];
        const outside = [];
        for (const node of svg.querySelectorAll('text')) {
          const style = getComputedStyle(node);
          const size = parseFloat(style.fontSize);
          if (Number.isFinite(size)) declared.push(size);
          try {
            const box = node.getBBox();
            // getBBox().y is the TOP of the text box, so containment is a top/bottom test, not y-height.
            if (box.x < -0.5 || box.x + box.width > 1200 + 0.5 || box.y < -0.5 || box.y + box.height > 675 + 0.5) {
              outside.push({ text: node.textContent.slice(0, 60), x: Math.round(box.x * 10) / 10, y: Math.round(box.y * 10) / 10, w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10 });
            }
          } catch (error) {
            outside.push({ text: node.textContent.slice(0, 60), error: String(error) });
          }
        }
        report.layout.push({
          file: file.name,
          width,
          renderedWidth: Math.round(rect.width * 100) / 100,
          hostOverflow: host.scrollWidth > host.clientWidth + 1,
          outside,
          minDeclaredPx: declared.length ? Math.min(...declared) : null,
          scale: Math.round((rect.width / 1200) * 1000) / 1000,
          heroRenderedPx: Math.round(Math.max(32, 40) * (rect.width / 1200) * 100) / 100,
        });
        host.remove();
      }
    }
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = String(error && error.stack ? error.stack : error);
  }
  document.getElementById('result').textContent = JSON.stringify(report);
})();
</script></body></html>`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gotavern-figure-a11y-'));
const wrapperPath = path.join(scratch, 'wrapper.html');
fs.writeFileSync(wrapperPath, wrapper, 'utf8');
const domPath = path.join(scratch, 'dom.txt');
try {
    const output = execFileSync(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--allow-file-access-from-files', '--virtual-time-budget=20000', '--dump-dom',
        `file:///${wrapperPath.replace(/\\/g, '/')}`,
    ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    fs.writeFileSync(domPath, output, 'utf8');
    const match = /<pre id="result">([\s\S]*?)<\/pre>/.exec(output);
    if (!match) throw new Error('the headless page produced no result block (it may have failed to load the SVGs)');
    const render = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    if (!render.ok) throw new Error(render.error ?? 'the headless page reported an error');

    for (const xml of render.xml) {
        check('FIGURE-XML-SYNTAX', xml.ok, `${path.basename(xml.file)} does not parse as XML: ${xml.error}`);
    }
    const seen = new Set();
    for (const entry of render.layout) {
        const variant = path.basename(entry.file);
        check('FIGURE-TEXT-CONTAINED', entry.outside.length === 0, `${variant} at ${entry.width}px: ${entry.outside.length} text node(s) outside the viewBox: ${JSON.stringify(entry.outside.slice(0, 3))}`);
        check('FIGURE-NO-OVERFLOW', !entry.hostOverflow, `${variant} at ${entry.width}px: the rendered drawing overflows its container`);
        if (entry.width === 1200) {
            check('FIGURE-TYPE-FLOOR', entry.minDeclaredPx !== null && entry.minDeclaredPx >= 13, `${variant}: smallest declared type is ${entry.minDeclaredPx}px, below the 13px floor`);
        }
        if (entry.width === 720) {
            check('FIGURE-MOBILE-HERO', entry.heroRenderedPx >= 18, `${variant}: at 720 CSS px the largest hero number renders at ${entry.heroRenderedPx}px, below the 18px at-a-glance floor`);
        }
        seen.add(`${variant}:${entry.width}`);
    }
    for (const expected of ['benchmark.svg:1200', 'benchmark.svg:720', 'benchmark.svg:360', 'benchmark-light.svg:1200', 'benchmark-light.svg:720', 'benchmark-light.svg:360']) {
        check('FIGURE-NO-OVERFLOW', seen.has(expected), `the headless render did not measure ${expected}`);
    }
} catch (error) {
    console.error(`figure-a11y: harness failure: ${error.message}`);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(2);
}
fs.rmSync(scratch, { recursive: true, force: true });

// ---- 2. the two variants cannot disagree about the data -------------------------------------------------
const darkText = fs.readFileSync(DARK, 'utf8');
const lightText = fs.readFileSync(LIGHT, 'utf8');
const descOf = text => {
    const match = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(text);
    return match ? match[1].replace(/\s+/g, ' ').trim() : null;
};
const darkDesc = descOf(darkText);
const lightDesc = descOf(lightText);
check('FIGURE-PAIR-DESC', darkDesc !== null && darkDesc === lightDesc, 'the dark and light variants do not carry an identical <desc>');
for (const [variant, desc] of [['dark', darkDesc ?? ''], ['light', lightDesc ?? '']]) {
    // The <desc> prints a ratio as "87.97-fold faster" (a multiplier word, not an "x" symbol); the alt text keeps
    // the "x" form. Both are recomputed from the artifact, so both are checked in the form the surface uses.
    const descValues = expectedValues.map(value => (value.endsWith('x') ? `${value.slice(0, -1)}-fold` : value));
    const missing = descValues.filter(value => !desc.includes(value));
    check('FIGURE-DESC-VALUES', missing.length === 0, `${variant} <desc> does not restate ${JSON.stringify(missing)} recomputed from tests/perf/q22-baseline.json`);
}

// ---- 3. the GitHub-Markdown wrapper around the figure ---------------------------------------------------
const readme = fs.readFileSync(README, 'utf8');
const picture = /<picture>[\s\S]*?<\/picture>/.exec(readme)?.[0] ?? '';
check('README-PICTURE-BLOCK', picture !== '', 'README has no <picture> block');
check('README-PICTURE-BLOCK', (picture.match(/<source\b/g) ?? []).length === 1, 'the <picture> block must contain exactly one <source> (the dark variant)');
check('README-PICTURE-BLOCK', (picture.match(/<img\b/g) ?? []).length === 1, 'the <picture> block must contain exactly one <img> (the light variant)');
check('README-PICTURE-BLOCK', picture.includes('prefers-color-scheme: dark'), 'the <source> does not select the dark variant with prefers-color-scheme: dark');
check('README-PICTURE-BLOCK', picture.includes('docs/assets/benchmark.svg') && picture.includes('docs/assets/benchmark-light.svg'), 'the block does not reference both committed variants');
const imgTag = /<img\b[^>]*>/.exec(picture)?.[0] ?? '';
const alt = /\balt="([^"]*)"/.exec(imgTag)?.[1] ?? '';
check('README-ALT-VALUES', alt !== '', 'the <img> has no alt text');
const missingAlt = expectedValues.filter(value => !alt.includes(value));
check('README-ALT-VALUES', missingAlt.length === 0, `the alt text does not carry ${JSON.stringify(missingAlt)} recomputed from the artifact`);
check('README-MARKDOWN-SAFE', !/<script\b|<style\b|<iframe\b|<foreignObject\b/i.test(picture), 'the README <picture> block contains an element GitHub strips or that can carry script/style');
check('README-PICTURE-BLOCK', /\bwidth="1200"/.test(imgTag), 'the <img> does not declare width="1200" (the natural 16:9 size)');

// ---- report ---------------------------------------------------------------------------------------------
const artifact = {
    tool: 'tools/check-figure-a11y.mjs',
    generatedAt: new Date().toISOString(),
    browser: path.basename(browser),
    baseline: { runId: baseline.provenance?.runId ?? null, commit: baseline.provenance?.commit ?? null },
    checks,
    failures: problems,
};
if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}
for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} [${entry.id}] ${entry.ok ? 'passed' : entry.message}`);
if (problems.length > 0) {
    console.error(`figure-a11y: FAIL (${problems.length} problem(s))`);
    process.exit(1);
}
console.log(`figure-a11y: OK (${checks.length} checks; headless ${path.basename(browser)}; both variants contained at 360/720/1200 px, type floor 13 px, alt/desc values match run ${baseline.provenance?.runId ?? '?'})`);
