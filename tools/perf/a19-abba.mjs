#!/usr/bin/env node

// a19-abba: paired, order-alternating comparison of two GoTavern binaries at process level.
//
// WHY THIS EXISTS. The alpha.19 protocol (CHARTER §7.2) requires same-host, same-input ABBA (A,B / B,A / A,B),
// cold and warm reported separately, CPU and memory separately, with the claim surviving the spread. A single
// a19-boot run of one binary cannot make a paired claim: the host's load drifts between runs, and on this
// 2-core host the drift is larger than most per-change deltas. This wrapper interleaves the two subjects round
// by round (order flipped every round), runs the SAME a19-boot harness for both, and applies a TWO-PART
// separation rule: a change is only called an improvement when (a) EVERY candidate observation is better than
// EVERY baseline observation and (b) neither subject's own repeats spread by more than 20% (A19_ABBA_MAX_SPREAD).
// Otherwise the row is reported as "not separable". Part (b) is not decoration: the first self-test run of this
// harness (two runs of the SAME binary, host shared with two other lanes) produced non-overlapping series and a
// confident "baseline-better" verdict for identical subjects, because a load spike landed inside one subject's
// repeats. A harness that can do that is broken, so the data-quality gate is part of the classification.
//
// It deliberately measures PROCESS-level facts only (boot, RSS, HTTP latency). Allocation totals (`B/op`,
// `allocs/op`) are deterministic and come from internal/server/bench_test.go; this file never mixes the two.
//
// USAGE
//   node tools/perf/a19-abba.mjs \
//     --baseline base=<binary built from the current tree> \
//     --candidate cand=<binary with the change> \
//     --scale cards --cards 10000 --image-bytes 4096 --card-bytes 2048 \
//     --rounds 3 --requests 6 --data-route characters \
//     --work-dir <scratch>/abba --out <artifact>.json --load-label "quiet: no other lane"
//
// SELF-TEST (the harness's own teeth):
//   node tools/perf/a19-abba.mjs --baseline a=<binary> --candidate b=<the SAME binary> ...
//   Identical subjects MUST come out "not separable" on a loaded host, and may also be "not separable" on a
//   quiet one. A harness that reports a winner when both subjects are the same binary is broken; run this
//   before believing any paired result.
//
// EXIT CODES: 0 measured; 1 a subject round failed (named in the artifact); 2 usage/setup failure.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const bootHarness = path.join(here, 'a19-boot.mjs');

function usage(message) {
    if (message) console.error(`a19-abba: ${message}\n`);
    console.error(`Usage: node tools/perf/a19-abba.mjs --baseline name=<path> --candidate name=<path> [options]

  --baseline name=<binary>   left-hand subject (e.g. the pre-change build)
  --candidate name=<binary>  right-hand subject (e.g. the change under test)
  --scale/--cards/--image-bytes/--card-bytes/--chats/--chat-bytes/--worlds/--world-bytes
                             passed through to tools/perf/a19-boot.mjs
  --rounds <n>               ABBA rounds (default 3; order flips each round)
  --requests <n>             data-route requests per boot (default 6; first is the cold-cache request)
  --data-route <name>        characters|worlds|settings|chats (default characters)
  --poll-ms <n>              readiness poll interval (default 2)
  --work-dir <dir>           scratch root (default <repo>/../a19-perf/abba)
  --out <file>               artifact (default <work-dir>/a19-abba-<stamp>.json)
  --load-label <text>        what else was running (required for an honest reading)
`);
    process.exit(2);
}

function parseSubject(flag, value) {
    const equals = (value ?? '').indexOf('=');
    if (equals <= 0) usage(`${flag} needs name=path`);
    const name = value.slice(0, equals);
    const binary = path.resolve(value.slice(equals + 1));
    if (!fs.existsSync(binary)) usage(`${flag} ${name}: no such file ${binary}`);
    return { name, binary };
}

function parseArguments(argv) {
    const options = {
        baseline: null, candidate: null, scale: 'cards', cards: 10000,
        imageBytes: 4096, cardBytes: 2048, chats: 10, chatBytes: 262144, worlds: 50, worldBytes: 32768,
        rounds: 3, requests: 6, dataRoute: 'characters', pollMs: 2,
        workDir: path.join(repoRoot, '..', 'a19-perf', 'abba'), out: null,
        loadLabel: 'unlabelled (shared host; treat absolute ms and the winner as within-run only)',
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = () => {
            const next = argv[index + 1];
            if (next === undefined || next.startsWith('--')) usage(`${flag} needs a value`);
            index += 1;
            return next;
        };
        switch (flag) {
            case '--baseline': options.baseline = parseSubject(flag, value()); break;
            case '--candidate': options.candidate = parseSubject(flag, value()); break;
            case '--scale': options.scale = value(); break;
            case '--cards': options.cards = Number(value()); break;
            case '--image-bytes': options.imageBytes = Number(value()); break;
            case '--card-bytes': options.cardBytes = Number(value()); break;
            case '--chats': options.chats = Number(value()); break;
            case '--chat-bytes': options.chatBytes = Number(value()); break;
            case '--worlds': options.worlds = Number(value()); break;
            case '--world-bytes': options.worldBytes = Number(value()); break;
            case '--rounds': options.rounds = Number(value()); break;
            case '--requests': options.requests = Number(value()); break;
            case '--data-route': options.dataRoute = value(); break;
            case '--poll-ms': options.pollMs = Number(value()); break;
            case '--work-dir': options.workDir = path.resolve(value()); break;
            case '--out': options.out = path.resolve(value()); break;
            case '--load-label': options.loadLabel = value(); break;
            case '--help': usage(); break;
            default: usage(`unknown flag ${flag}`);
        }
    }
    if (!options.baseline || !options.candidate) usage('--baseline and --candidate are required');
    if (options.rounds < 2) usage('--rounds must be >= 2 so the order can flip (ABBA needs both orders)');
    return options;
}

const options = parseArguments(process.argv.slice(2));

function sha256File(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function binaryVersion(binary) {
    const result = spawnSync(binary, ['version'], { encoding: 'utf8' });
    return result.status === 0 ? (result.stdout.split('\n')[0] ?? '').trim() : null;
}

function goVersion() {
    const result = spawnSync('go', ['version'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function gitFacts() {
    const run = args => {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
        return result.status === 0 ? result.stdout.trim() : null;
    };
    return { commit: run(['rev-parse', 'HEAD']), branch: run(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: (run(['status', '--porcelain']) ?? '').length > 0 };
}

// Median of a numeric series. Percentiles here are descriptive only; the ABBA claim is the separation rule.
function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function summarise(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, min: sorted[0], median: median(sorted), max: sorted[sorted.length - 1], series: sorted };
}

// lower-wins classification over the paired rounds. `left` is the baseline series, `right` the candidate.
//
// A NON-OVERLAP TEST ALONE IS NOT ENOUGH, and the harness's own self-test is what proved it: two runs of the
// SAME binary on a host with a co-tenant load spike produced non-overlapping series (e.g. warm-data p50 1936/1922
// ms against 2133/4159 ms) and the wrapper confidently reported "baseline-better" for identical subjects. The
// order flip cannot cancel a spike that lands inside one subject's repeats, so the data itself has to be gated:
// a metric is only separable when the two series do not overlap AND neither subject's own repeats spread by more
// than `maxSpread` (relative, default 0.20). A metric that fails the spread gate is reported as not separable
// with the measured spread in the detail, which is the honest reading: the host could not hold a condition still
// long enough to support the claim. On a quiet host identical subjects spread far below the threshold and the
// self-test passes; on a loaded host it now says "not separable" instead of inventing a winner.
const MAX_WITHIN_SUBJECT_SPREAD = Number(process.env.A19_ABBA_MAX_SPREAD ?? 0.20);
// A second, independent gate: a real claim must also be substantively larger than the drift between two runs of
// the same binary. The first noise-gated self-test still reported a winner on coldReadyRssBytes for IDENTICAL
// subjects (31.44 MB vs 32.94 MB, 4.8%) because RSS repeats are tight and their ranges merely did not overlap.
// Anything below this effect floor is not claimable at process level on any host, so it is reported as not
// separable with the measured difference named.
const MIN_RELATIVE_EFFECT = Number(process.env.A19_ABBA_MIN_EFFECT ?? 0.05);

function relativeSpread(values) {
    if (values.length < 2) return 0;
    const low = Math.min(...values);
    const high = Math.max(...values);
    if (low <= 0) return high > 0 ? Infinity : 0;
    return (high - low) / low;
}

function classify(left, right, effectFloor = MIN_RELATIVE_EFFECT) {
    if (!left.length || left.length !== right.length) {
        return { verdict: 'incomplete', detail: 'series lengths differ or are empty' };
    }
    const leftSpread = relativeSpread(left);
    const rightSpread = relativeSpread(right);
    const noiseSpread = Math.max(leftSpread, rightSpread);
    const leftMedian = median(left);
    const rightMedian = median(right);
    const effect = leftMedian > 0 ? Math.abs(rightMedian - leftMedian) / leftMedian : 0;
    const applyNoiseGate = verdict => {
        if (noiseSpread > MAX_WITHIN_SUBJECT_SPREAD) {
            return {
                verdict: 'not-separable',
                detail: `within-subject spread ${(noiseSpread * 100).toFixed(1)}% exceeds ${(MAX_WITHIN_SUBJECT_SPREAD * 100).toFixed(0)}%; the host did not hold still, so no direction is claimable`,
                leftSpread,
                rightSpread,
                effect,
            };
        }
        if (effect < effectFloor) {
            return {
                verdict: 'not-separable',
                detail: `median difference ${(effect * 100).toFixed(1)}% is below the ${(effectFloor * 100).toFixed(0)}% effect floor; the row is not claimable`,
                leftSpread,
                rightSpread,
                effect,
            };
        }
        return {
            verdict,
            detail: `non-overlapping series, within-subject spread ${(noiseSpread * 100).toFixed(1)}%, median difference ${(effect * 100).toFixed(1)}%`,
            leftSpread,
            rightSpread,
            effect,
        };
    };
    const allRightLower = right.every((value, index) => value < left[index]);
    const allLeftLower = left.every((value, index) => value < right[index]);
    if (allRightLower) return applyNoiseGate('candidate-better');
    if (allLeftLower) return applyNoiseGate('baseline-better');
    return { verdict: 'not-separable', detail: 'the two per-round series overlap; report as no improvement inside noise', leftSpread, rightSpread };
}

function routeRows(bootRound, key) {
    return (bootRound?.[key] ?? []).filter(row => row && typeof row.ms === 'number');
}

function bootMetrics(artifact) {
    const round = artifact?.rounds?.[0];
    if (!round) return null;
    const coldRequests = routeRows(round, 'coldRequests');
    const warmRequests = routeRows(round, 'warmRequests').filter(row => row.cache === 'warm');
    const warmMs = warmRequests.map(row => row.ms);
    return {
        coldBootMs: typeof round.coldBootMs === 'number' ? round.coldBootMs : null,
        warmBootMs: typeof round.warmBootMs === 'number' ? round.warmBootMs : null,
        coldDataRequestMs: coldRequests.length ? coldRequests[0].ms : null,
        warmDataP50Ms: warmMs.length ? median(warmMs) : null,
        warmDataMaxMs: warmMs.length ? Math.max(...warmMs) : null,
        coldReadyRssBytes: round.coldReady?.rssBytes ?? null,
        coldPeakRssBytes: round.coldFinal?.peakRssBytes ?? null,
        warmReadyRssBytes: round.warmReady?.rssBytes ?? null,
        statuses: [...new Set([...coldRequests, ...warmRequests].map(row => row.status))],
        errors: round.errors ?? [],
    };
}

function runSubject(subject, round, outFile) {
    const args = [
        bootHarness,
        '--binary', subject.binary,
        '--scale', options.scale,
        '--cards', String(options.cards),
        '--image-bytes', String(options.imageBytes),
        '--card-bytes', String(options.cardBytes),
        '--chats', String(options.chats),
        '--chat-bytes', String(options.chatBytes),
        '--worlds', String(options.worlds),
        '--world-bytes', String(options.worldBytes),
        '--rounds', '1',
        '--requests', String(options.requests),
        '--data-route', options.dataRoute,
        '--poll-ms', String(options.pollMs),
        '--work-dir', path.join(options.workDir, 'subjects', subject.name),
        '--out', outFile,
        '--load-label', `${options.loadLabel} [round ${round} of ${options.rounds}, subject ${subject.name}]`,
    ];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    if (result.status !== 0) {
        return { artifact: null, failure: `a19-boot exited ${result.status}: ${(result.stderr ?? '').slice(-1500)}` };
    }
    try {
        return { artifact: JSON.parse(fs.readFileSync(outFile, 'utf8')), failure: null };
    } catch (error) {
        return { artifact: null, failure: `a19-boot artifact unreadable: ${error.message}` };
    }
}

function main() {
    fs.mkdirSync(options.workDir, { recursive: true });
    if (!fs.existsSync(bootHarness)) usage(`missing ${bootHarness}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = options.out ?? path.join(options.workDir, `a19-abba-${stamp}.json`);

    const artifact = {
        harness: 'tools/perf/a19-abba.mjs',
        environment: {
            git: gitFacts(),
            go: goVersion(),
            node: process.version,
            os: { platform: process.platform, arch: process.arch, release: os.release() },
            cpu: { model: os.cpus()[0]?.model ?? null, logicalCores: os.cpus().length },
            totalRamBytes: os.totalmem(),
            loadLabel: options.loadLabel,
            startedAt: new Date().toISOString(),
        },
        subjects: [
            { role: 'baseline', name: options.baseline.name, path: options.baseline.binary, sha256: sha256File(options.baseline.binary), sizeBytes: fs.statSync(options.baseline.binary).size, version: binaryVersion(options.baseline.binary) },
            { role: 'candidate', name: options.candidate.name, path: options.candidate.binary, sha256: sha256File(options.candidate.binary), sizeBytes: fs.statSync(options.candidate.binary).size, version: binaryVersion(options.candidate.binary) },
        ],
        parameters: { ...options, baseline: options.baseline.name, candidate: options.candidate.name },
        order: [],
        rounds: [],
        summary: null,
        notes: [
            'Process-level facts only: boot, RSS (procstat PeakWorkingSetSize/VmHWM), and HTTP latency. B/op and allocs/op are NOT measured here; they come from internal/server/bench_test.go and are deterministic.',
            'Separation rule: a metric is only called an improvement when every candidate observation is better than every baseline observation over the paired rounds; otherwise it is reported as not separable.',
            'Identical-subject self-test: point --baseline and --candidate at the SAME binary. A separation reported there is a harness defect.',
            'Windows stop is abrupt (child.kill / taskkill); cold and warm are separate boots over the same round tree.',
        ],
    };

    const records = new Map([[options.baseline.name, []], [options.candidate.name, []]]);
    const failures = [];
    for (let round = 1; round <= options.rounds; round += 1) {
        const order = round % 2 === 1 ? [options.baseline, options.candidate] : [options.candidate, options.baseline];
        artifact.order.push({ round, order: order.map(subject => subject.name) });
        for (const subject of order) {
            const outFile = path.join(options.workDir, 'runs', `round-${round}-${subject.name}.json`);
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            const { artifact: bootArtifact, failure } = runSubject(subject, round, outFile);
            if (failure) {
                failures.push({ round, subject: subject.name, failure });
                continue;
            }
            const metrics = bootMetrics(bootArtifact);
            records.get(subject.name).push({ round, metrics, artifactPath: outFile });
            console.log(`round ${round}: ${subject.name} cold ${metrics.coldBootMs === null ? 'n/a' : `${metrics.coldBootMs.toFixed(1)}ms`} warm ${metrics.warmBootMs === null ? 'n/a' : `${metrics.warmBootMs.toFixed(1)}ms`} warmP50 ${metrics.warmDataP50Ms === null ? 'n/a' : `${metrics.warmDataP50Ms.toFixed(1)}ms`}`);
        }
    }

    const metricNames = ['coldBootMs', 'warmBootMs', 'coldDataRequestMs', 'warmDataP50Ms', 'warmDataMaxMs', 'coldReadyRssBytes', 'coldPeakRssBytes', 'warmReadyRssBytes'];
    // RSS rows need a LARGER effect floor than latency rows: two consecutive runs of the SAME binary on this host
    // produced peak-RSS medians 12.7% apart (368.7 MB vs 321.9 MB), so a 5% floor would let identical subjects be
    // called a winner. The floor is per metric and stated in the artifact; a real RSS regression (a leak) is far
    // above it. Until a quiet-window self-test comes out all-not-separable, peak RSS stays UNPROVEN anyway.
    const effectFloors = {
        coldReadyRssBytes: 0.15,
        coldPeakRssBytes: 0.25,
        warmReadyRssBytes: 0.15,
    };
    const metricLabels = {
        coldBootMs: 'spawn -> first GET /version 200, cold boot (lower is better)',
        warmBootMs: 'spawn -> first GET /version 200, warm boot (lower is better)',
        coldDataRequestMs: 'first data request, cold process cache (lower is better)',
        warmDataP50Ms: 'data request median over the warm repeats (lower is better)',
        warmDataMaxMs: 'data request max over the warm repeats (lower is better)',
        coldReadyRssBytes: 'RSS at cold readiness (lower is better)',
        coldPeakRssBytes: 'PEAK RSS after the cold round (procstat; lower is better)',
        warmReadyRssBytes: 'RSS at warm readiness (lower is better)',
    };
    const summary = {};
    for (const metric of metricNames) {
        const baselineSeries = records.get(options.baseline.name).map(record => record.metrics?.[metric]).filter(value => typeof value === 'number');
        const candidateSeries = records.get(options.candidate.name).map(record => record.metrics?.[metric]).filter(value => typeof value === 'number');
        summary[metric] = {
            label: metricLabels[metric],
            baseline: summarise(baselineSeries),
            candidate: summarise(candidateSeries),
            classification: classify(baselineSeries, candidateSeries, effectFloors[metric] ?? MIN_RELATIVE_EFFECT),
            effectFloor: effectFloors[metric] ?? MIN_RELATIVE_EFFECT,
        };
    }
    artifact.summary = summary;
    artifact.failures = failures;
    artifact.rounds = [...records.entries()].map(([name, list]) => ({ subject: name, rounds: list }));
    artifact.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    console.log(`artifact: ${out}`);
    for (const metric of metricNames) {
        const row = summary[metric];
        console.log(`${metric}: ${row.classification.verdict} (baseline median ${row.baseline?.median ?? 'n/a'}, candidate median ${row.candidate?.median ?? 'n/a'})`);
    }
    if (failures.length) {
        console.error(`failures: ${failures.map(entry => `${entry.subject}@${entry.round}: ${entry.failure}`).join(' | ')}`);
        return 1;
    }
    return 0;
}

try {
    process.exit(main());
} catch (error) {
    console.error(`a19-abba: ${error.stack ?? error}`);
    process.exit(2);
}
