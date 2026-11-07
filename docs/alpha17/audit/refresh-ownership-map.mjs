#!/usr/bin/env node
// alpha.17 ownership-map citation validator + refresher (read-only over the tree).
//
// Usage:
//   node docs/alpha17/audit/refresh-ownership-map.mjs [repo] [--check]
//
// It loads docs/alpha16/ownership-map.json (the alpha.16 machine-readable union), walks every string and
// validates every `path:line` citation against the CURRENT tree (repository and the pinned ../SillyTavern
// checkout), then writes docs/alpha17/ownership-map.json with a refreshed commit/date and a `refresh`
// record. With --check it only reports.
//
// CITATION CONVENTIONS IN THE SOURCE MAP. The alpha.16 map mixes three spellings, which its assembler
// resolved with context: repository-relative ("internal/server/x.go:10"), package-relative
// ("settings_save.go:43" inside the internal/server package row), and pinned-relative
// ("src/endpoints/settings.js:209" under ../SillyTavern). This validator resolves, in order: the literal
// repository path; the literal path under ../SillyTavern; a UNIQUE basename match in the repository; a
// UNIQUE basename match under ../SillyTavern. An ambiguous basename is reported as AMBIGUOUS, not guessed.
//
// A citation fails when the path cannot be resolved, or the line is outside the file.

import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(process.argv.filter(a => !a.startsWith('--'))[2] ?? '.');
const checkOnly = process.argv.includes('--check');
const sourcePath = path.join(repo, 'docs/alpha16/ownership-map.json');
const outPath = path.join(repo, 'docs/alpha17/ownership-map.json');
const pinned = path.resolve(repo, '..', 'SillyTavern');

function gitHead() {
  const head = fs.readFileSync(path.join(repo, '.git/HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;
  return fs.readFileSync(path.join(repo, '.git', head.slice(5).trim()), 'utf8').trim();
}
const commit = gitHead();

const citation = /((?:\.\.\/SillyTavern\/)?[A-Za-z0-9_.\-/]+\.(?:go|js|mjs|cjs|json|jsonl|yml|yaml|md|sh|ps1|txt)):(\d+)(?:-(\d+))?/g;
const EXT = new Set(['.go', '.js', '.mjs', '.cjs', '.json', '.jsonl', '.yml', '.yaml', '.md', '.sh', '.ps1', '.txt']);

function indexByBasename(root) {
  const byName = new Map();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.browser-bin') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(abs); continue; }
      if (!entry.isFile()) continue;
      if (!EXT.has(path.extname(entry.name).toLowerCase())) continue;
      const list = byName.get(entry.name) ?? [];
      list.push(abs);
      byName.set(entry.name, list);
    }
  }
  return byName;
}
const repoIndex = indexByBasename(repo);
const pinnedIndex = indexByBasename(pinned);

const lineCache = new Map();
function lineCount(abs) {
  if (!lineCache.has(abs)) {
    try { lineCache.set(abs, fs.readFileSync(abs, 'utf8').split('\n').length); }
    catch { lineCache.set(abs, -1); }
  }
  return lineCache.get(abs);
}

const PREFIX_HINTS = [
  'internal/server/', 'internal/outbound/', 'internal/app/', 'internal/startup/', 'internal/commandline/',
  'internal/configinit/', 'internal/migrate/', 'internal/tokenizers/', 'internal/longlivedfixture/',
  'internal/fsretry/', 'internal/lockacquire/', 'internal/fixtures/', 'cmd/gotavern/', 'tests/', 'tools/',
];
const KNOWN_PATHS = {
  // Pinned dependency file cited by basename only in the alpha.16 hypothesis row (a package under
  // ../SillyTavern/node_modules; the pinned checkout is read-only and this is the file the row means).
  'MemoryStorage.js': '../SillyTavern/node_modules/rate-limiter-flexible/lib/component/MemoryStorage/MemoryStorage.js',
};
// Source citations the alpha.16 map wrote in a SHORTHAND name that no longer resolves by basename. Each is
// re-pointed at the current file and recorded as a fix in the refreshed map rather than silently accepted.
const BASENAME_FIXUPS = {
  'folder_update.go': 'internal/server/image_metadata_folder_update.go',
  'folder_delete.go': 'internal/server/image_metadata_folder_delete.go',
  'folder_assignments.go': 'internal/server/image_metadata_folder_assignments.go',
  'folder_set_thumbnails.go': 'internal/server/image_metadata_folder_set_thumbnails.go',
};
const appliedFixups = new Set();
const EXTERNAL_PREFIXES = ['GOROOT/', 'node/'];

function resolve(rel) {
  if (EXTERNAL_PREFIXES.some(p => rel.startsWith(p))) return { external: true, how: 'external' };
  if (KNOWN_PATHS[rel]) {
    const abs = path.resolve(repo, KNOWN_PATHS[rel]);
    if (fs.existsSync(abs)) return { abs, how: 'known' };
  }
  if (BASENAME_FIXUPS[rel]) {
    const abs = path.join(repo, BASENAME_FIXUPS[rel]);
    if (fs.existsSync(abs)) {
      appliedFixups.add(rel);
      return { abs, how: 'basename-fixup' };
    }
  }
  const hintedInternal = rel.startsWith('app/') ? path.join(repo, 'internal', rel) : null;
  if (hintedInternal && fs.existsSync(hintedInternal)) return { abs: hintedInternal, how: 'repo-prefix' };
  const direct = path.join(repo, rel);
  if (fs.existsSync(direct)) return { abs: direct, how: 'repo' };
  const pin = path.join(pinned, rel.replace(/^\.\.\/SillyTavern\//, ''));
  if (fs.existsSync(pin)) return { abs: pin, how: 'pinned' };
  for (const prefix of PREFIX_HINTS) {
    const hinted = path.join(repo, prefix, rel);
    if (fs.existsSync(hinted)) return { abs: hinted, how: 'repo-prefix' };
  }
  const base = path.basename(rel);
  const repoMatches = repoIndex.get(base) ?? [];
  if (repoMatches.length === 1) return { abs: repoMatches[0], how: 'repo-basename' };
  const pinMatches = pinnedIndex.get(base) ?? [];
  if (pinMatches.length === 1) return { abs: pinMatches[0], how: 'pinned-basename' };
  return null;
}

const failures = [];
const resolvedBy = new Map();
let checked = 0;
let external = 0;

function walk(value, where) {
  if (typeof value === 'string') {
    let m;
    citation.lastIndex = 0;
    while ((m = citation.exec(value)) !== null) {
      const rel = m[1];
      const start = Number(m[2]);
      const end = m[3] ? Number(m[3]) : start;
      checked += 1;
      const found = resolve(rel);
      if (!found) {
        failures.push(`${where}: ${rel}:${start} -> UNRESOLVED`);
        continue;
      }
      if (found.external) {
        external += 1;
        continue;
      }
      resolvedBy.set(found.how, (resolvedBy.get(found.how) ?? 0) + 1);
      const count = lineCount(found.abs);
      if (count < 0) { failures.push(`${where}: ${rel}:${start} -> unreadable ${found.abs}`); continue; }
      if (start < 1 || start > count) { failures.push(`${where}: ${rel}:${start} -> file has ${count} lines`); continue; }
      if (end < start || end > count) failures.push(`${where}: ${rel}:${start}-${end} -> file has ${count} lines`);
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${where}[${i}]`)); return; }
  if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) walk(v, `${where}.${k}`); }
}

const map = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
walk(map, '$');

console.log(`citations checked: ${checked} (external/out-of-tree: ${external})`);
for (const [how, n] of [...resolvedBy.entries()].sort()) console.log(`  resolved ${how}: ${n}`);
if (failures.length) {
  console.log(`CITATION FAILURES: ${failures.length}`);
  for (const f of failures.slice(0, 100)) console.log('  ' + f);
  if (failures.length > 100) console.log(`  ... ${failures.length - 100} more`);
} else {
  console.log(`all citations valid at ${commit}`);
}

const refreshed = structuredClone(map);
refreshed.commit = commit;
refreshed.refresh = {
  date: new Date().toISOString().slice(0, 10),
  head: commit,
  method: 'docs/alpha17/audit/refresh-ownership-map.mjs',
  source: 'docs/alpha16/ownership-map.json',
  citationsChecked: checked,
  citationsFailed: failures.length,
  resolvedBy: Object.fromEntries([...resolvedBy.entries()].sort()),
  note: 'Citations re-validated against the current tree and ../SillyTavern; hypothesis statuses are refreshed by the audit findings lane.',
};
if (!checkOnly) {
  fs.writeFileSync(outPath, JSON.stringify(refreshed, null, 2) + '\n', 'utf8');
  console.log(`wrote ${path.relative(repo, outPath)} (${fs.statSync(outPath).size} bytes), commit=${commit}`);
}
process.exitCode = failures.length ? 1 : 0;
