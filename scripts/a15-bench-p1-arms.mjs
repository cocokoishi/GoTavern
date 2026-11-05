#!/usr/bin/env node
// A15 P1 ON/OFF ARMS — the paired measurement of the identity-keyed card-text cache, at a QUIET host.
//
// WHY THIS EXISTS. The P1 cache was landed on allocation evidence (every warm row falls) and a ns win on the
// small-card/large-text rows, while the 10,000-card ns row did not move outside the shared host's spread. The
// decision the Lead recorded is "re-measure at the quiet host; if 10k still shows nothing, revert rather than keep
// an unmeasurable optimisation". This script is that measurement, prepared in advance so the quiet window is spent
// measuring instead of editing. When the cold-guard benchmark row was removed from internal/server/bench_test.go
// (commit 47da1de, so the scheduled committed-baseline gate stays green), THIS script became the only place the
// cold-first-request number is measured.
//
// WHAT IT DOES, exactly:
//   1. Resolves --uncached-commit and requires it to be the ACTUAL PARENT of the commit that added
//      internal/server/characters_card_cache.go (the P1 cache commit). A stale ancestor with a byte-identical
//      function is refused, because the arms must differ by exactly the P1 commit. The extracted pre-change block
//      and the P1 commit's cached block are both hashed and recorded.
//   2. Saves the cache-enabled readCharacterDataStrict from the current tree and verifies it really consults
//      loadCharacterCardTextCache.
//   3. Builds ONE test binary with the cache enabled.
//   4. Swaps in the pre-change readCharacterDataStrict and builds a SECOND test binary with identical flags.
//   5. Restores the cache-enabled file IMMEDIATELY and verifies its sha256 equals the saved bytes; the product
//      file is never left in the swapped state (exit/signal handler, plus a final hash check that refuses to
//      claim success if it is dirty).
//   6. Runs alternating rounds (even rounds cached-then-uncached, odd rounds reversed). Each arm gets:
//        - a COLD invocation: -test.benchtime=1x on each benchmark row, which is the first request in a fresh
//          process, i.e. an empty cache — the cold-first-request number the removed benchmark row used to report
//          (the uncached arm has no cache at all, so its cold and repeat work are the same code path);
//        - a REPEAT invocation: -test.benchtime=<warm, default 10x> on the same rows, where the first of the ten
//          iterations is still cold. The artifact reports the raw average AND a derived repeat-only estimate
//          ((N*avgN - 1*avg1)/(N-1)) so the cold iteration's weight is visible instead of hidden.
//   7. Writes every raw output and a JSON artifact (commit, P1 cache commit, uncached parent commit, the block
//      hashes, host facts, Go/GOMAXPROCS, build flags, binary hashes, arm order per round, per-phase per-round
//      metrics, medians, ratios, derived repeat cost, raw paths, load label) under tests/perf/out/a15/.
//
// WHAT IT DOES NOT DO: it does not commit, does not touch any file outside the product function during the two
// builds, and does not run unless `--confirm-quiet` is passed — a shared host makes this measurement worthless.
//
// USAGE
//   node scripts/a15-bench-p1-arms.mjs --confirm-quiet --uncached-commit ade1e75 \
//     --rounds 3 --load-label "quiet: no other lane running" [--warm-benchtime 10x] [--work-dir DIR] [--out DIR]
// Exit codes: 0 measurement written; 1 a build/run/restore failed; 2 usage, wrong parent, or the host was not
// declared quiet.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const PRODUCT_FILE = path.join(repoRoot, 'internal', 'server', 'characters_card.go');
const CACHE_FILE = 'internal/server/characters_card_cache.go';
const BENCH_SET = 'BenchmarkCharactersAllScale/(cards_10000_4KB_image|cards_100_640KB_image)$';

function usage(reason) {
    console.error(`${reason}\n\nusage: node scripts/a15-bench-p1-arms.mjs --confirm-quiet --uncached-commit <parent-of-the-cache-commit>`);
    process.exit(2);
}

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

function git(args) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

if (!process.argv.includes('--confirm-quiet')) usage('refusing to measure on an undeclared host: pass --confirm-quiet (Lead protocol: one arm per quiet window)');
const uncachedCommit = argumentValue('--uncached-commit');
if (!uncachedCommit) usage('--uncached-commit is required: it must be the parent of the P1 cache commit');
const rounds = Number(argumentValue('--rounds', '3'));
const warmBenchtime = argumentValue('--warm-benchtime', '10x');
const coldBenchtime = '1x';
const loadLabel = argumentValue('--load-label', 'quiet');
const workDir = path.resolve(argumentValue('--work-dir', path.join(repoRoot, '..', 'a15-work', 'p1-arms')));
const outDir = path.resolve(argumentValue('--out', path.join(repoRoot, 'tests', 'perf', 'out', 'a15')));
if (!Number.isFinite(rounds) || rounds < 2) usage('--rounds must be at least 2 (alternating arms need a pair)');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

function capture(command, args, options = {}) {
    return execFileSync(command, args, { encoding: 'utf8', ...options, stdio: ['ignore', 'pipe', 'pipe'] });
}

// THE PARENT CHECK. The cache file was ADDED by the P1 commit; its parent is the tree whose
// readCharacterDataStrict is the pre-change function. Naming an older ancestor with a byte-identical function
// would make the arms differ by more than P1 whenever that ancestor also lacked later commits, so it is refused.
const cacheCommit = git(['log', '--diff-filter=A', '--format=%H', '--', CACHE_FILE]).split('\n').filter(Boolean)[0] ?? null;
if (!cacheCommit) usage(`no commit added ${CACHE_FILE} in this history; cannot identify the P1 commit to take the parent from`);
const cacheCommitParent = git(['rev-parse', `${cacheCommit}^`]);
const resolvedUncached = git(['rev-parse', `${uncachedCommit}^{commit}`]);
if (resolvedUncached !== cacheCommitParent) {
    usage(`--uncached-commit ${uncachedCommit} resolves to ${resolvedUncached}, but the P1 cache commit ${cacheCommit} has parent ${cacheCommitParent}; name the ACTUAL parent`);
}

const FUNCTION_PATTERN = /func readCharacterDataStrict\(filePath string\) \(string, error\) \{[\s\S]*?\n\}\n/;

function currentFunctionBlock() {
    const text = fs.readFileSync(PRODUCT_FILE, 'utf8');
    const match = FUNCTION_PATTERN.exec(text);
    if (!match) throw new Error('readCharacterDataStrict block not found in the product file');
    return match[0];
}

function functionBlockAt(commit) {
    const source = capture('git', ['show', `${commit}:internal/server/characters_card.go`], { cwd: repoRoot });
    const match = FUNCTION_PATTERN.exec(source);
    if (!match) throw new Error(`no readCharacterDataStrict block in ${commit}:internal/server/characters_card.go`);
    return match[0];
}

const uncachedBlock = functionBlockAt(cacheCommitParent);
if (uncachedBlock.includes('loadCharacterCardTextCache')) throw new Error(`the parent ${cacheCommitParent} already contains the cache; the history is not what this script assumes`);
const p1CachedBlock = functionBlockAt(cacheCommit);
if (!p1CachedBlock.includes('loadCharacterCardTextCache')) throw new Error(`the P1 commit ${cacheCommit} does not contain the cache lookup; the history is not what this script assumes`);
const uncachedBlockSha = sha256(Buffer.from(uncachedBlock, 'utf8'));
const p1CachedBlockSha = sha256(Buffer.from(p1CachedBlock, 'utf8'));

function replaceFunction(block) {
    const text = fs.readFileSync(PRODUCT_FILE, 'utf8');
    fs.writeFileSync(PRODUCT_FILE, text.replace(FUNCTION_PATTERN, block), 'utf8');
}

let productFileSaved = null;
let productFileHashAtStart = null;

function restoreProductFile() {
    if (productFileSaved === null) return;
    fs.writeFileSync(PRODUCT_FILE, productFileSaved, 'utf8');
    const nowHash = sha256(fs.readFileSync(PRODUCT_FILE));
    if (nowHash !== productFileHashAtStart) {
        // The one failure that must be impossible to miss: a measurement that leaves the product tree swapped is
        // worse than no measurement.
        console.error(`FATAL: ${PRODUCT_FILE} was NOT restored (sha256 ${nowHash} != ${productFileHashAtStart})`);
        process.exitCode = 2;
        throw new Error('product file restore failed');
    }
    console.error(`restored ${path.relative(repoRoot, PRODUCT_FILE)} (sha256 ${nowHash.slice(0, 16)}…)`);
}

process.on('exit', () => { if (productFileSaved !== null && typeof process.exitCode === 'number' && process.exitCode !== 0) restoreProductFile(); });
process.on('SIGINT', () => { try { restoreProductFile(); } catch { /* reported */ } process.exit(130); });

function goEnvironment() {
    return { version: capture('go', ['version'], { cwd: repoRoot }).trim(), GOMAXPROCS: process.env.GOMAXPROCS ?? null };
}

function buildTestBinary(label) {
    const binary = path.join(workDir, `server-test-${label}.exe`);
    execFileSync('go', ['test', '-c', '-o', binary, './internal/server'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    return binary;
}

function runBenchArm(binary, label, phase, benchtime) {
    const args = [
        '-test.run', '^$',
        '-test.bench', BENCH_SET,
        '-test.benchmem',
        `-test.benchtime=${benchtime}`,
        '-test.count=1',
    ];
    const rawPath = path.join(workDir, `raw-${label}-${phase}.txt`);
    const result = capture(binary, args, { cwd: path.join(repoRoot, 'internal', 'server') });
    fs.writeFileSync(rawPath, result, 'utf8');
    return { rawPath, metrics: parseBenchOutput(result) };
}

function parseBenchOutput(text) {
    const metrics = {};
    for (const line of text.split('\n')) {
        if (!line.includes('ns/op')) continue;
        const name = /^\s*(Benchmark\S+)/.exec(line)?.[1];
        const ns = /([\d.]+) ns\/op/.exec(line)?.[1];
        const bytes = /([\d.]+) B\/op/.exec(line)?.[1];
        const allocs = /([\d.]+) allocs\/op/.exec(line)?.[1];
        if (!name || !ns) continue;
        metrics[name] = { nsPerOp: Number(ns), bytesPerOp: bytes === undefined ? null : Number(bytes), allocsPerOp: allocs === undefined ? null : Number(allocs) };
    }
    return metrics;
}

function median(values) {
    const sorted = [...values].filter(value => typeof value === 'number').sort((left, right) => left - right);
    if (sorted.length === 0) return null;
    return sorted[Math.floor(sorted.length / 2)];
}

function summariseMetric(arms, phase, name, metric) {
    const values = { cached: [], uncached: [] };
    for (const arm of arms) {
        if (arm.phase !== phase) continue;
        const row = arm.metrics[name];
        if (row && typeof row[metric] === 'number') values[arm.arm].push(row[metric]);
    }
    const cachedMedian = median(values.cached);
    const uncachedMedian = median(values.uncached);
    return {
        cachedMedian,
        uncachedMedian,
        ratioCachedOverUncached: (cachedMedian !== null && uncachedMedian) ? cachedMedian / uncachedMedian : null,
        cachedValues: values.cached,
        uncachedValues: values.uncached,
    };
}

async function main() {
    await fsp.mkdir(workDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });
    productFileSaved = fs.readFileSync(PRODUCT_FILE, 'utf8');
    productFileHashAtStart = sha256(productFileSaved);
    const cachedBlock = currentFunctionBlock();
    if (!cachedBlock.includes('loadCharacterCardTextCache')) throw new Error('the current product function does not consult the cache; this is not the cache-enabled tree');
    if (cachedBlock === uncachedBlock) throw new Error('the cached and uncached function blocks are identical; nothing to compare');
    const currentCachedBlockSha = sha256(Buffer.from(cachedBlock, 'utf8'));

    if (process.argv.includes('--dry-run')) {
        productFileSaved = null;
        console.log(JSON.stringify({
            dryRun: true,
            p1CacheCommit: cacheCommit,
            p1CacheCommitParent: cacheCommitParent,
            resolvedUncachedCommit: resolvedUncached,
            parentCheck: 'PASS: --uncached-commit is the actual parent of the commit that added the cache file',
            uncachedFunctionBytes: uncachedBlock.length,
            uncachedFunctionSha256: uncachedBlockSha,
            uncachedHasCacheLookup: uncachedBlock.includes('loadCharacterCardTextCache'),
            currentCachedFunctionBytes: cachedBlock.length,
            currentCachedFunctionSha256: currentCachedBlockSha,
            p1CachedFunctionSha256: p1CachedBlockSha,
            currentMatchesP1Commit: currentCachedBlockSha === p1CachedBlockSha,
            rounds,
            coldBenchtime,
            warmBenchtime,
            benchSet: BENCH_SET,
            productFileSha256: productFileHashAtStart,
        }, null, 2));
        return;
    }

    console.error(`building the cache-enabled test binary (rounds=${rounds}, cold=${coldBenchtime}, warm=${warmBenchtime})`);
    const cachedBinary = buildTestBinary('cached');
    replaceFunction(uncachedBlock);
    console.error('building the pre-change test binary');
    const uncachedBinary = buildTestBinary('uncached');
    restoreProductFile();
    productFileSaved = null; // restored and verified: the exit handler must not restore twice

    const binaries = { cached: cachedBinary, uncached: uncachedBinary };
    const arms = [];
    for (let round = 1; round <= rounds; round += 1) {
        const order = round % 2 === 1 ? ['cached', 'uncached'] : ['uncached', 'cached'];
        for (const arm of order) {
            // Cold FIRST, in its own process: the benchmark plants a fresh tree and the first request has an empty
            // cache, which is the number the removed cold-guard benchmark used to report.
            console.error(`round ${round}/${rounds}: arm ${arm} cold (${coldBenchtime})`);
            const cold = runBenchArm(binaries[arm], `${arm}-r${round}`, 'cold', coldBenchtime);
            arms.push({ round, arm, phase: 'cold', order, rawPath: cold.rawPath, metrics: cold.metrics });
            console.error(`round ${round}/${rounds}: arm ${arm} repeat (${warmBenchtime})`);
            const warm = runBenchArm(binaries[arm], `${arm}-r${round}`, 'warm', warmBenchtime);
            arms.push({ round, arm, phase: 'warm', order, rawPath: warm.rawPath, metrics: warm.metrics });
        }
    }

    const benchmarkNames = [...new Set(arms.flatMap(arm => Object.keys(arm.metrics)))].sort();
    const warmIterations = Number.parseInt(warmBenchtime, 10) || 10;
    const summary = {};
    for (const name of benchmarkNames) {
        const metrics = {
            nsPerOp: {
                cold: summariseMetric(arms, 'cold', name, 'nsPerOp'),
                warm: summariseMetric(arms, 'warm', name, 'nsPerOp'),
            },
            bytesPerOp: {
                cold: summariseMetric(arms, 'cold', name, 'bytesPerOp'),
                warm: summariseMetric(arms, 'warm', name, 'bytesPerOp'),
            },
            allocsPerOp: {
                cold: summariseMetric(arms, 'cold', name, 'allocsPerOp'),
                warm: summariseMetric(arms, 'warm', name, 'allocsPerOp'),
            },
        };
        // Derived repeat-only ns/op: (warmIterations*avgWarm - 1*avgCold) / (warmIterations-1), per arm. Only ns/op
        // is decomposed: the cold iteration's allocation share cannot be subtracted from a per-op average safely.
        const derive = key => {
            const coldMedian = metrics.nsPerOp.cold[key];
            const warmMedian = metrics.nsPerOp.warm[key];
            if (typeof coldMedian !== 'number' || typeof warmMedian !== 'number' || warmIterations <= 1) return null;
            return (warmIterations * warmMedian - coldMedian) / (warmIterations - 1);
        };
        metrics.nsPerOp.repeatOnlyEstimate = {
            cached: derive('cachedMedian'),
            uncached: derive('uncachedMedian'),
            note: `derived as (${warmIterations}*repeatAverage - coldAverage)/${warmIterations - 1}; assumes the repeat invocation's first iteration is the only cold one`,
        };
        summary[name] = metrics;
    }

    const facts = {
        harness: 'scripts/a15-bench-p1-arms.mjs',
        commit: git(['rev-parse', 'HEAD']),
        p1CacheCommit: cacheCommit,
        uncachedCommit: cacheCommitParent,
        parentCheck: 'PASS: --uncached-commit verified equal to the parent of the P1 cache commit',
        uncachedFunctionSha256: uncachedBlockSha,
        currentCachedFunctionSha256: currentCachedBlockSha,
        p1CachedFunctionSha256: p1CachedBlockSha,
        workingTree: git(['status', '--porcelain']).split('\n').filter(Boolean),
        go: goEnvironment(),
        host: {
            platform: process.platform,
            release: os.release(),
            arch: process.arch,
            cpuModel: os.cpus()[0]?.model ?? null,
            logicalCores: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
        },
        buildFlags: 'go test -c (CGO_ENABLED inherited), identical for both arms',
        binaries: {
            cached: { path: cachedBinary, sha256: sha256(fs.readFileSync(cachedBinary)) },
            uncached: { path: uncachedBinary, sha256: sha256(fs.readFileSync(uncachedBinary)) },
        },
        rounds,
        coldBenchtime,
        warmBenchtime,
        benchSet: BENCH_SET,
        loadLabel,
        declaredQuiet: true,
        startedAt: new Date().toISOString(),
        notes: [
            'Both arms are the SAME tree except readCharacterDataStrict; each arm is a separately built test binary.',
            'Rounds alternate the arm order so a slow host period cannot systematically favour one arm.',
            'The cold invocation is one request in a fresh process (empty cache) and is the cold-first-request number.',
            'The repeat invocation averages warmIterations iterations of which the first is still cold; nsPerOp.repeatOnlyEstimate subtracts that iteration and is the repeat-cost estimate.',
            'B/op and allocs/op are the allocation claim; ns/op is paired within one quiet window.',
            'The product file was restored and verified before any arm ran; no timed work happens in the swapped state.',
        ],
    };
    const artifactPath = path.join(outDir, `p1-arms-${STAMP}.json`);
    await fsp.writeFile(artifactPath, `${JSON.stringify({ schemaVersion: 1, facts, arms, summary }, null, 2)}\n`, 'utf8');
    console.log(`artifact: ${artifactPath}`);
    for (const [name, metrics] of Object.entries(summary)) {
        const show = (metric, unit) => {
            const cold = metrics[metric].cold;
            const warm = metrics[metric].warm;
            const ratio = value => value === null ? 'n/a' : value.toFixed(3);
            return `${metric}: cold ${cold.uncachedMedian?.toFixed(0) ?? 'n/a'}->${cold.cachedMedian?.toFixed(0) ?? 'n/a'} ${unit}, repeat ${warm.uncachedMedian?.toFixed(0) ?? 'n/a'}->${warm.cachedMedian?.toFixed(0) ?? 'n/a'} ${unit} (ratio ${ratio(warm.ratioCachedOverUncached)})`;
        };
        console.log(`${name}: ${show('nsPerOp', 'ns/op')} | ${show('bytesPerOp', 'B/op')} | ${show('allocsPerOp', 'allocs')}`);
    }
}

try {
    await main();
} catch (error) {
    console.error(`a15-bench-p1-arms: ${error?.stack ?? error}`);
    try { restoreProductFile(); } catch { /* already reported */ }
    process.exit(1);
}
