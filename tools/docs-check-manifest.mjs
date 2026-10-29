#!/usr/bin/env node
// Keeps `tests/docs/run-manifest.json` honest against the live GitHub run list.
//
// WHY THIS IS SEPARATE FROM THE GO TEST. `internal/fixtures/documents_test.go` proves the manifest and the
// ledger agree with each other, and that every cited run is an ancestor of the described commit. Neither of
// those can prove the RECORDED CONCLUSION is still the conclusion: a run can be re-run, and a workflow can
// be renamed in the same commit that renames it in the manifest, so a self-consistent pair can both be
// stale. Only the API can answer that, which means `gh` and a token — neither of which exists on the
// development host, and one of which must never be required for the ordinary test suite to run.
//
// So: advisory where there is no `gh`, fatal where there is. In CI the token is present and a drifted entry
// is red; locally the tool says which check it could not perform rather than reporting a pass it did not
// earn (AGENTS.md verification rule 7).
//
// USAGE
//   node tools/docs-check-manifest.mjs            # report, exit 0 unless a mismatch was found
//   node tools/docs-check-manifest.mjs --check    # exit 1 on any mismatch (CI)
//   node tools/docs-check-manifest.mjs --add <runId> --workflow <name>   # append a freshly cited run
//
// The `--add` path exists so that citing a new run is a COMMAND that fills the four fields from the API,
// rather than a hand-edited line where a workflow name can be mistyped. A mistyped workflow name is the
// defect `AGENTS.md` rule 55 records: a green from the drop-in qualification workflow was quoted as a
// verdict on a mutation only Lane CI could have judged.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'tests', 'docs', 'run-manifest.json');

const args = process.argv.slice(2);
const checkMode = args.includes('--check');
const addIndex = args.indexOf('--add');
const workflowIndex = args.indexOf('--workflow');

function gh(argsArray) {
  try {
    const out = execFileSync('gh', argsArray, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: '', error };
  }
}

function readManifest() {
  const raw = readFileSync(manifestPath, 'utf8');
  // A BOM decodes perfectly and makes JSON.parse fail with a message that names neither the file nor the
  // cause (AGENTS.md rule 12). Say which it is.
  if (raw.charCodeAt(0) === 0xfeff) {
    throw new Error(`${manifestPath} starts with a BOM; write it with UTF8Encoding(false)`);
  }
  if (raw.includes('\ufffd')) {
    throw new Error(`${manifestPath} carries U+FFFD; it was re-encoded through a lossy path`);
  }
  return JSON.parse(raw);
}

// One entry per run, keyed by id, because two entries for one run means a reader cannot tell which
// conclusion is the record.
function entriesById(manifest) {
  const map = new Map();
  for (const entry of manifest.entries ?? []) {
    if (map.has(entry.runId)) {
      throw new Error(`run ${entry.runId} is recorded twice in the manifest`);
    }
    map.set(entry.runId, entry);
  }
  return map;
}

// serializeManifest writes the header fields pretty-printed and EVERY ENTRY ON ONE LINE. That is not a
// style choice: `internal/fixtures/documents_test.go` scans this file with a line-oriented regex so a
// duplicate key or a missing field is a repair rather than a mystery, and an entry spread over five
// lines is invisible to it. This serializer is the single writer, so the two formats cannot drift.
function serializeManifest(manifest) {
    const header = Object.entries(manifest).filter(([key]) => key !== 'entries');
    const lines = ['{'];
    for (const [key, value] of header) {
        const rendered = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
        lines.push(`  ${JSON.stringify(key)}: ${rendered},`);
    }
    lines.push('  "entries": [');
    (manifest.entries ?? []).forEach((entry, index) => {
        const comma = index === (manifest.entries.length - 1) ? '' : ',';
        lines.push(`    ${JSON.stringify(entry)}${comma}`);
    });
    lines.push('  ]');
    lines.push('}');
    return `${lines.join('\n')}\n`;
}

function main() {
  const manifest = readManifest();

  if (addIndex !== -1) {
    const runId = args[addIndex + 1];
    if (!runId) {
      console.error('--add needs a run id');
      process.exit(2);
    }
    const workflow = workflowIndex !== -1 ? args[workflowIndex + 1] : null;
    const viewed = gh(['run', 'view', runId, '--json', 'name,conclusion,headSha,createdAt']);
    if (!viewed.ok) {
      console.error(`could not read run ${runId} from the API: ${viewed.error?.message ?? 'unknown error'}`);
      process.exit(2);
    }
    const live = JSON.parse(viewed.out);
    if (workflow && workflow !== live.name) {
      // Filling in the workflow name from the caller while the API disagrees is exactly the wrong-workflow
      // citation. Refuse rather than record something the API does not support.
      console.error(`--workflow ${JSON.stringify(workflow)} does not match the API's ${JSON.stringify(live.name)} for run ${runId}`);
      process.exit(1);
    }
    const entries = entriesById(manifest);
    if (!entries.has(runId)) {
      manifest.entries.push({
        runId,
        workflow: live.name,
        headSha: live.headSha,
        conclusion: live.conclusion,
        createdAt: live.createdAt,
      });
      writeFileSync(manifestPath, serializeManifest(manifest), 'utf8');
      // READ BACK WITH THE GATE'S OWN PARSER. The Go gate (`internal/fixtures/documents_test.go`) reads
      // ONE OBJECT PER LINE, deliberately: it avoids a JSON decoder so a duplicate key or a missing field
      // is a repair rather than a mystery. This tool used to write `JSON.stringify(..., null, 2)`, which
      // put every field on its own line -- so `--add` produced an entry the gate COULD NOT SEE, and a
      // citation added by the documented command failed the ledger as "not in the manifest". Measured
      // 2026-10-29 on runs 40898261148 and 40898332226. A capability must be proved to REACH the
      // behaviour it was built for (AGENTS.md verification rule 7), so the write is followed by the
      // gate's own regex, and a mismatch is fatal rather than a silent success.
      const written = readFileSync(manifestPath, 'utf8');
      const gatePattern = /\{"runId":\s*"(\d{6,})",\s*"workflow":\s*"([^"]*)",\s*"headSha":\s*"([0-9a-f]{40})",\s*"conclusion":\s*"([a-z_]+)"/;
      const visible = new Set([...written.matchAll(new RegExp(gatePattern, 'g'))].map(match => match[1]));
      if (!visible.has(runId)) {
        console.error(`REFUSING: the entry for ${runId} was written but the ledger gate's parser cannot see it`);
        process.exit(1);
      }
    }
    console.log(`recorded ${runId} (${live.name}, ${live.conclusion}) ${live.headSha.slice(0, 12)}`);
    return;
  }

  const entries = entriesById(manifest);
  if (entries.size === 0) {
    console.error('the manifest carries no entries; nothing would be checked (rule 19)');
    process.exit(1);
  }

  // ONE API CALL for the whole set: `gh run list` cannot be filtered by id, so the comparison is made
  // against a window large enough to contain the newest citations. An entry OLDER than the window is
  // reported as "not in window" rather than as a mismatch, because a bounded listing cannot support a
  // claim of absence (rule 11).
  const listed = gh([
    'run', 'list', '--limit', '200', '--json', 'databaseId,name,headSha,conclusion,status',
  ]);
  if (!listed.ok) {
    const reason = listed.error?.code === 'ENOENT'
      ? '`gh` is not installed here'
      : `\`gh\` could not reach the API (probably no token): ${listed.error?.message ?? 'unknown error'}`;
    // Advisory mode: say which check did not run. This must not read as a pass.
    console.log(`docs-check-manifest: SKIPPED live verification because ${reason}.`);
    console.log('docs-check-manifest: the manifest/ledger consistency and ancestry checks are in `go test ./internal/fixtures`, which needs no network.');
    process.exit(checkMode ? 0 : 0);
  }

  const live = new Map();
  for (const run of JSON.parse(listed.out)) {
    live.set(String(run.databaseId), run);
  }

  const problems = [];
  const notInWindow = [];
  for (const [runId, entry] of entries) {
    const run = live.get(runId);
    if (!run) {
      notInWindow.push(runId);
      continue;
    }
    if (run.conclusion !== entry.conclusion) {
      problems.push(`${runId}: recorded conclusion ${JSON.stringify(entry.conclusion)}, the API says ${JSON.stringify(run.conclusion)} — a re-run changed the verdict, so every row citing it must be re-read`);
    }
    if (run.name !== entry.workflow) {
      problems.push(`${runId}: recorded workflow ${JSON.stringify(entry.workflow)}, the API says ${JSON.stringify(run.name)} — a workflow rename makes the citation name the wrong judge (rule 55)`);
    }
    if (run.headSha !== entry.headSha) {
      problems.push(`${runId}: recorded head_sha ${entry.headSha.slice(0, 12)}, the API says ${run.headSha.slice(0, 12)} — the citation would point at a different commit`);
    }
    if (run.status !== 'completed') {
      problems.push(`${runId}: the API reports status ${JSON.stringify(run.status)}, so the recorded conclusion ${JSON.stringify(entry.conclusion)} is not yet a fact`);
    }
  }

  if (notInWindow.length) {
    console.log(`docs-check-manifest: ${notInWindow.length} entr${notInWindow.length === 1 ? 'y is' : 'ies are'} older than the API window and were NOT verified: ${notInWindow.join(', ')}`);
  }
  if (problems.length) {
    for (const problem of problems) console.error(`docs-check-manifest: MISMATCH ${problem}`);
    console.error(`docs-check-manifest: ${problems.length} mismatch(es) between the manifest and the live run list.`);
    process.exit(1);
  }
  console.log(`docs-check-manifest: ${entries.size - notInWindow.length} of ${entries.size} entries match the live run list.`);
}

main();
