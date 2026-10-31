// Assemble the PUBLISHED release body from the curated note plus the same-SHA qualification evidence.
//
// WHY THIS IS A SEPARATE, TESTABLE PROGRAM. The publish path has three things that must agree: the curated note (a
// claim document), the same-SHA gate (the evidence that the claim was produced by runs at this tag's commit), and the
// checksums of the assets this very run built (the note cites them). Doing that in an inline shell step means the only
// execution it ever gets is a tagged release -- the most expensive possible moment to discover a bug. The decision
// logic is here, the shell hands it a note, a checksums file and (live or from a fixture) the runs, and
// `scripts/release-governance.test.mjs` exercises it offline.
//
// The note may NOT be edited into the tagged commit after qualification: a note that cites run ids is necessarily
// written after those runs, and editing it would change the commit under judgement. That is why the note is release
// metadata read at publish time and the evidence table is generated here, from the runs at the tag's own commit.

import { readFileSync } from 'node:fs';
import { evaluateGates, renderEvidence, validateManifest } from './release-governance/gates.mjs';
import { validateReleaseNotes } from './release-governance/notes.mjs';

/**
 * @returns {{ ok: boolean, body: string|null, problems: string[], observations: string[], gateRows: object[] }}
 */
export function assembleReleaseBody({ notesText = null, tag, checksumsText = null, runs = null, manifest = null, sha, repo = '' }) {
    const problems = [];
    const observations = [];

    if (notesText === null) {
        // A prerelease without a curated note is allowed a generated body, but then no evidence table can be attached
        // (gh --generate-notes writes its own body). The caller reports that; this function does not invent a note.
        if (runs !== null) {
            const verdict = evaluateGates({ manifest, runs, sha });
            for (const row of verdict.rows) observations.push(`${row.workflow}: ${row.verdict}`);
            if (!verdict.ok) problems.push(...verdict.problems);
        }
        return { ok: problems.length === 0, body: null, problems, observations, gateRows: [] };
    }

    const noteVerdict = validateReleaseNotes({ text: notesText, tag, checksumsText });
    problems.push(...noteVerdict.problems);
    observations.push(...noteVerdict.observations);

    let gateRows = [];
    if (runs === null) {
        problems.push('no runs were supplied, so the same-SHA gate could not run; refusing to call an unverified body publishable');
    } else {
        if (!manifest) {
            problems.push('no release manifest was supplied, so the same-SHA gate has no required-workflow list');
        } else {
            const manifestProblems = validateManifest(manifest);
            problems.push(...manifestProblems);
            if (manifestProblems.length === 0) {
                const verdict = evaluateGates({ manifest, runs, sha });
                gateRows = verdict.rows;
                problems.push(...verdict.problems);
                for (const row of verdict.rows) observations.push(`${row.workflow}: ${row.verdict}${row.runId === null ? '' : ` (run ${row.runId})`}`);
                // A GREEN GATE IS NOT A PUBLISHABLE BODY: the note must also be clean. Returning success here regardless
                // would have made the checksum/placeholder tests pass for the wrong reason -- which is exactly what the
                // checksum-mismatch test caught when this function was first written.
                if (verdict.ok && problems.length === 0) {
                    const evidence = renderEvidence({ rows: verdict.rows, sha, repo });
                    return { ok: true, body: `${notesText.trimEnd()}\n${evidence}`, problems, observations, gateRows };
                }
            }
        }
    }

    return { ok: false, body: null, problems, observations, gateRows };
}

// CLI: node scripts/assemble-release-body.mjs --tag <tag> --sha <40-hex> --notes <file> --checksums <file>
//        [--runs-json <file>] [--manifest docs/release-manifest.json] [--out <file>] [--repo owner/repo]
// Live mode (no --runs-json) uses GITHUB_TOKEN/GH_TOKEN and GITHUB_REPOSITORY, exactly like verify-release-gates.mjs.
async function main() {
    const args = process.argv.slice(2);
    const valueOf = (flag, fallback = null) => {
        const index = args.indexOf(flag);
        return index === -1 ? fallback : args[index + 1] ?? fallback;
    };
    const tag = valueOf('--tag');
    const sha = valueOf('--sha');
    const notesPath = valueOf('--notes');
    const checksumsPath = valueOf('--checksums');
    const runsJsonPath = valueOf('--runs-json');
    const manifestPath = valueOf('--manifest', 'docs/release-manifest.json');
    const outPath = valueOf('--out');
    const repo = valueOf('--repo', process.env.GITHUB_REPOSITORY ?? '');
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

    if (!tag || !sha) {
        console.error('::error::assemble-release-body needs --tag and --sha');
        return 1;
    }
    if (!/^[0-9a-f]{40}$/.test(sha)) {
        console.error(`::error::--sha must be a 40-hex commit; got ${JSON.stringify(sha)}`);
        return 1;
    }
    const notesText = notesPath ? readFileSync(notesPath, 'utf8') : null;
    const checksumsText = checksumsPath ? readFileSync(checksumsPath, 'utf8') : null;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    let runs;
    if (runsJsonPath) {
        const fixture = JSON.parse(readFileSync(runsJsonPath, 'utf8'));
        runs = Array.isArray(fixture) ? fixture : fixture.workflow_runs ?? [];
    } else {
        const { fetchRunsFromApi } = await import('./release-governance/gates.mjs');
        runs = await fetchRunsFromApi({ sha, repo, token });
    }

    const result = assembleReleaseBody({ notesText, tag, checksumsText, runs, manifest, sha, repo });
    for (const observation of result.observations) console.log(`  note: ${observation}`);
    if (!result.ok) {
        for (const problem of result.problems) console.error(`::error::${problem}`);
        return 1;
    }
    if (result.body === null) {
        console.log('no curated note: the publish step will use generated notes and attach no evidence table');
        return 0;
    }
    if (outPath) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(outPath, result.body, 'utf8');
        console.log(`assembled the published release body at ${outPath} (${Buffer.byteLength(result.body, 'utf8')} bytes)`);
    } else {
        process.stdout.write(result.body);
    }
    return 0;
}

// Only run main() when executed directly (`node scripts/assemble-release-body.mjs`), not when imported by the test.
const invokedDirectly = process.argv[1] && /assemble-release-body\.mjs$/.test(process.argv[1].replaceAll('\\', '/'));
if (invokedDirectly) {
    process.exitCode = await main();
}
