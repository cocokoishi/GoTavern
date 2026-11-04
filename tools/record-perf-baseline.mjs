#!/usr/bin/env node
// Record the committed performance baseline from a RECORDED q22 paired-benchmark artefact.
//
// WHY THIS EXISTS. The alpha.13 tag tree carried a README RSS row (1,057 MB / 36.9 MB) that matched
// neither the run it cited (1,108,514,816 B / 38,647,808 B) nor its own figure (1,109 / 38.6 decimal MB).
// The class of defect was that the docs were hand-copied from a run nobody re-read. This script makes
// the artefact the single source of truth: it takes the downloaded q22 artefact plus the SAME RUN's
// smoke-metrics record (for host facts the q22 artefact does not carry), validates both, and writes
// tests/perf/q22-baseline.json, which `tools/check-perf-docs.mjs` then compares the README, the figure
// and the provenance against. No measured value is typed by a human anywhere in this path.
//
// WHAT IT REFUSES, and why: an artefact that is missing a summary metric, whose two subjects did not
// answer every round, whose sample counts disagree, or whose soak did not complete is NOT a baseline.
// The q22 harness itself asserts those four structural properties; this script re-reads them from the
// recorded JSON rather than trusting the run's green conclusion (the artefact is the evidence).
//
// USAGE (the one-commit update procedure; docs/perf-baseline.md records the same steps):
//   gh run download <run-id> -n q22-paired-benchmark -D /tmp/q22
//   gh run download <run-id> -n smoke-metrics      -D /tmp/smoke
//   node tools/record-perf-baseline.mjs \
//     --q22 /tmp/q22/q22-paired-benchmark.json \
//     --host /tmp/smoke/smoke-metrics.json \
//     --run-id <run-id> --commit <full 40-hex commit> \
//     --out tests/perf/q22-baseline.json
//
// `--host` is REQUIRED for a release baseline because GOAL 15.2 requires OS/CPU/RAM in the record and
// the q22 artefact records only the runner image. Omitting it is allowed only with --no-host, which
// records the absence explicitly instead of inventing facts.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function argument(name) {
    const index = process.argv.indexOf(name);
    return index < 0 ? null : process.argv[index + 1] ?? null;
}
const q22Path = argument('--q22');
const hostPath = argument('--host');
const runId = argument('--run-id');
const commit = argument('--commit');
const outPath = argument('--out');
const noHost = process.argv.includes('--no-host');
const recordedAt = argument('--recorded-at') ?? new Date().toISOString();
if (!q22Path || !runId || !commit || !outPath) {
    console.error('usage: node tools/record-perf-baseline.mjs --q22 <q22-paired-benchmark.json> [--host <smoke-metrics.json> | --no-host] --run-id <id> --commit <full sha> --out <path>');
    process.exit(2);
}
if (!/^[0-9]+$/.test(runId)) throw new Error(`--run-id must be a GitHub Actions run id, got ${runId}`);
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`--commit must be a full 40-character hexadecimal commit id, got ${commit}`);
if (!hostPath && !noHost) throw new Error('--host <smoke-metrics.json> is required (GOAL 15.2 requires OS/CPU/RAM in the record); pass --no-host to record the absence explicitly');

function readJson(file, label) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
    } catch (error) {
        throw new Error(`${label} is not readable JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} is not a JSON object`);
    return parsed;
}

const report = readJson(q22Path, '--q22');
for (const field of ['summary', 'rounds', 'requestsPerRound', 'runnerImage', 'asserted']) {
    if (!(field in report)) throw new Error(`the q22 artefact is missing ${field}; refusing to record a baseline that cannot be checked`);
}
for (const subject of ['pinned', 'gotavern']) {
    const summary = report.summary[subject];
    if (!summary || typeof summary !== 'object') throw new Error(`the q22 artefact has no summary.${subject}`);
    for (const metric of ['bootMsMedian', 'rssBytesMedian', 'versionMedianMs', 'rootMedianMs']) {
        if (typeof summary[metric] !== 'number' || !Number.isFinite(summary[metric])) {
            throw new Error(`the q22 artefact summary.${subject}.${metric} is not a finite number; refusing to record it`);
        }
    }
    for (const sample of ['boot', 'rss', 'version', 'root']) {
        if (typeof summary.samples?.[sample] !== 'number') throw new Error(`the q22 artefact summary.${subject}.samples.${sample} is missing`);
    }
}
if (report.asserted.everyRoundAnswered !== true) throw new Error('the q22 artefact did not answer in every round; refusing to record it as a baseline');
if (report.asserted.sampleCountsMatch !== true) throw new Error('the q22 artefact sample counts disagree; refusing to record it as a baseline');
if (!Array.isArray(report.soak) || report.soak.length !== 2) throw new Error('the q22 artefact has no two-subject soak; refusing to record it as a baseline');
for (const entry of report.soak) {
    if (typeof entry.rssDriftBytes !== 'number' || typeof entry.p95DriftMs !== 'number' || !Array.isArray(entry.series) || entry.series.length === 0) {
        throw new Error(`the q22 artefact soak for ${entry.subject ?? 'unknown'} is incomplete; refusing to record it as a baseline`);
    }
}

let host = null;
if (hostPath) {
    const smoke = readJson(hostPath, '--host');
    if (!smoke.host || typeof smoke.host !== 'object') throw new Error('--host is not a smoke-metrics record (no host block)');
    // The two artefacts must describe the SAME run, or host facts from one run would be spliced into
    // another run's numbers -- the exact mixing GOAL 15.2 forbids.
    if (String(smoke.host.runId ?? '') !== runId) {
        throw new Error(`--host belongs to run ${smoke.host.runId ?? '<absent>'}, not ${runId}; refusing to splice two runs`);
    }
    if (String(smoke.host.sha ?? '') !== commit) {
        throw new Error(`--host measured ${smoke.host.sha ?? '<absent>'}, not ${commit}; refusing to splice two commits`);
    }
    host = {
        runnerImage: smoke.host.runnerImage ?? null,
        runnerImageVersion: smoke.host.runnerImageVersion ?? null,
        runnerOs: smoke.host.runnerOs ?? null,
        runnerArch: smoke.host.runnerArch ?? null,
        kernel: smoke.host.kernel ?? null,
        cpuCount: smoke.host.cpuCount ?? null,
        totalMemoryBytes: smoke.host.totalMemoryBytes ?? null,
        nodeVersion: smoke.host.nodeVersion ?? null,
        source: 'smoke-metrics.json host block from the SAME run id and commit',
    };
    if (host.runnerImage !== report.runnerImage) {
        throw new Error(`the q22 artefact says runnerImage ${report.runnerImage}, the smoke record says ${host.runnerImage}; refusing to splice two runners`);
    }
}

const baseline = {
    schemaVersion: 1,
    provenance: {
        runId,
        commit,
        workflow: 'GoTavern smoke metrics',
        job: 'paired-linux-amd64',
        artifact: 'q22-paired-benchmark',
        recordedAt,
        measuredBy: 'tests/perf/q22-paired-benchmark.mjs (--rounds 3 --requests 30, 10-minute soak per subject)',
        build: {
            cgoEnabled: '0',
            trimpath: true,
            ldflags: `-s -w -X main.version=paired-${runId}`,
            source: 'smoke-metrics.yml paired-linux-amd64 build step',
        },
        goVersion: {
            value: readGoDirective(),
            source: 'go.mod `go` directive at the measured commit; the workflow uses setup-go `go-version-file: go.mod`; the artefact itself does not record the toolchain',
        },
        gomaxprocs: {
            value: null,
            reason: 'the q22 harness sets no GOMAXPROCS, so it defaults to the runner CPU count; the environment is not recorded in the artefact, so it is named rather than invented',
        },
        host: host ?? { value: null, reason: 'recorded with --no-host: the q22 artefact carries the runner image only, not OS/CPU/RAM' },
        notes: [
            'The q22 artefact is embedded verbatim under `report`; no number is retyped.',
            'Host facts come from the smoke-metrics.json of the SAME run id and commit, verified by the recorder.',
            'A new run replaces this file and the docs it feeds in ONE commit; see docs/perf-baseline.md.',
        ],
    },
    report,
};

writeFileSync(path.resolve(outPath), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
const summary = baseline.report.summary;
console.log(`recorded ${outPath} from run ${runId} at ${commit}`);
console.log(`  cold start: pinned ${summary.pinned.bootMsMedian} ms / gotavern ${summary.gotavern.bootMsMedian} ms`);
console.log(`  rss:        pinned ${summary.pinned.rssBytesMedian} B / gotavern ${summary.gotavern.rssBytesMedian} B (decimal MB rule: /1e6)`);
console.log(`  host:       ${host ? `${host.runnerImage} ${host.runnerOs}/${host.runnerArch} ${host.cpuCount} vCPU ${host.totalMemoryBytes} B` : 'NOT RECORDED (--no-host)'}`);

function readGoDirective() {
    const goMod = readFileSync(path.join(ROOT, 'go.mod'), 'utf8');
    const match = /^go\s+([0-9]+\.[0-9]+\.[0-9]+)$/m.exec(goMod);
    return match ? match[1] : null;
}
