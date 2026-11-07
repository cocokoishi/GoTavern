// Runner fingerprint for the alpha.17 process-level performance baseline.
//
// WHY. GOAL.md 15.2 requires every measurement record to name the host and the build it ran on, and
// AGENTS.md forbids splicing numbers from different hosts into one claim. This script writes ONE JSON
// document with the facts a reader needs to decide whether two runs may be compared at all:
//   - OS build, CPU model, logical cores, RAM, architecture, Node/Go versions, GOMAXPROCS;
//   - git HEAD + dirty-file count, Go module, build flags and the subject binary's sha256/size;
//   - a storage fingerprint (open+write+fsync+close+unlink of 48 KiB, 12 samples, p50/p95/max) on the
//     filesystem the measured data roots live on, because every write route in this product is an
//     atomic fsync-bound write and a slow filesystem silently grades the host instead of the product.
//
// The method string is written next to every number so a reader can trace it to the call that produced
// it rather than to a convention. It is Layer A (Windows arm64 dev host) evidence, never Linux CI.
//
// USAGE: node tools/perf/fingerprint.mjs --out <file.json> --work-root <dir> --binary <gotavern.exe>
//        [--build-command "<text>"] [--label "<text>"]

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(2);
}

function option(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    if (!value) fail(`${name} needs a value`);
    return value;
}

const outPath = option('--out');
const workRoot = option('--work-root');
const binary = option('--binary');
if (!outPath || !workRoot || !binary) fail('usage: node tools/perf/fingerprint.mjs --out <file.json> --work-root <dir> --binary <gotavern.exe>');

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', '..');

function run(command, args, cwd = repoRoot) {
    try {
        return { ok: true, stdout: execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
    } catch (error) {
        return { ok: false, error: String(error?.message ?? error), stdout: '' };
    }
}

function windowsFacts() {
    if (process.platform !== 'win32') return null;
    const ver = run('cmd', ['/c', 'ver']);
    const build = run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'CurrentBuildNumber']);
    const ubr = run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'UBR']);
    const display = run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'DisplayVersion']);
    const match = value => {
        const found = /REG_SZ\s+(\S+)/.exec(value?.stdout ?? '');
        return found ? found[1] : null;
    };
    return {
        cmdVer: ver.ok ? ver.stdout : null,
        currentBuildNumber: match(build),
        ubr: match(ubr),
        displayVersion: match(display),
        osBuild: match(build) && match(ubr) ? `${match(build)}.${match(ubr)}` : match(build),
    };
}

function gitFacts() {
    const head = run('git', ['rev-parse', 'HEAD']);
    const status = run('git', ['status', '--porcelain']);
    return {
        commit: head.ok ? head.stdout : null,
        dirty: status.ok ? status.stdout.split('\n').filter(Boolean).length > 0 : null,
        dirtyFileCount: status.ok ? status.stdout.split('\n').filter(Boolean).length : null,
    };
}

function sha256File(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function summarise(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = fraction => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
    return { count: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

// The same probe shape as tests/perf/m5-eight-users.mjs:253-286, and for the same reason: synchronous, on the
// filesystem the subject writes to, with the body size the write routes use. 12 samples is the count the
// alpha.16 method recorded; the p50 is the comparison statistic because a 12-sample p95 is one outlier.
function measureDiskFingerprint(directory, bodyBytes = 49152, samples = 12) {
    const probeDirectory = path.join(directory, '.a17-disk-fingerprint');
    const payload = Buffer.alloc(bodyBytes, 0x61);
    const timings = [];
    try {
        mkdirSync(probeDirectory, { recursive: true });
        for (let index = 0; index < samples; index += 1) {
            const target = path.join(probeDirectory, `probe-${process.pid}-${index}.bin`);
            const startedAt = process.hrtime.bigint();
            const descriptor = openSync(target, 'w');
            try {
                writeSync(descriptor, payload);
                fsyncSync(descriptor);
            } finally {
                closeSync(descriptor);
            }
            timings.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
            unlinkSync(target);
        }
    } catch (error) {
        return { ok: false, error: String(error?.message ?? error), samples: [], p50: null, p95: null, max: null };
    }
    const summary = summarise(timings);
    return {
        ok: true,
        method: 'open+write+fsync+close+unlink of 48 KiB on the work-root filesystem, synchronous, once before any boot',
        bytes: payload.length,
        count: summary.count,
        min: summary.min,
        p50: summary.p50,
        p95: summary.p95,
        max: summary.max,
        samples: timings.map(value => Math.round(value * 1000) / 1000),
    };
}

const goVersion = run('go', ['version']);
const goEnv = ['GOOS', 'GOARCH', 'CGO_ENABLED', 'GOMAXPROCS'].reduce((accumulator, key) => {
    const result = run('go', ['env', key]);
    accumulator[key] = result.ok ? result.stdout : null;
    return accumulator;
}, {});

const document = {
    schema: 'gotavern.alpha17.runner-fingerprint/1',
    layer: 'LOCAL (Windows arm64 development host) — triage, NOT Linux CI release evidence',
    label: option('--label', null),
    generatedAt: new Date().toISOString(),
    host: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        version: os.version?.(),
        windows: windowsFacts(),
        cpuModel: os.cpus().length > 0 ? os.cpus()[0].model : null,
        logicalCores: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
        gomaxprocs: {
            environmentValue: goEnv.GOMAXPROCS || null,
            effective: Number(goEnv.GOMAXPROCS) > 0 ? Number(goEnv.GOMAXPROCS) : os.cpus().length,
            source: goEnv.GOMAXPROCS ? 'GOMAXPROCS environment variable' : 'unset; Go defaults to the logical CPU count recorded here',
        },
        nodeVersion: process.version,
        go: { version: goVersion.ok ? goVersion.stdout : null, env: goEnv },
    },
    repository: { ...gitFacts(), module: 'github.com/cocokoishi/gotavern' },
    build: {
        command: option('--build-command', null),
        flags: '-trimpath -ldflags="-s -w"',
        binary: path.resolve(binary),
        sha256: sha256File(binary),
        sizeBytes: statSync(binary).size,
    },
    diskFingerprint: measureDiskFingerprint(workRoot),
    comparabilityRule:
        'Two runs may be compared only when host.platform/arch, CPU model, effective GOMAXPROCS, Go version, ' +
        'build.flags, build.sha256 and the data scale/parameters are identical, and diskFingerprint.p50 is within ' +
        'max(3x, +2 ms) of the other run (the alpha.16 rule derived in docs/alpha16/m5-evidence.md 11.2).',
};

writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
    out: outPath,
    sha256: document.build.sha256,
    sizeBytes: document.build.sizeBytes,
    cpu: document.host.cpuModel,
    logicalCores: document.host.logicalCores,
    ram: document.host.totalMemoryBytes,
    gomaxprocs: document.host.gomaxprocs.effective,
    osBuild: document.host.windows?.osBuild ?? document.host.release,
    diskP50Ms: document.diskFingerprint.p50,
    diskP95Ms: document.diskFingerprint.p95,
}, null, 2));
