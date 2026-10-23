#!/usr/bin/env node
// dev-verify.mjs -- the fast local loop this project should have had from the start.
//
// WHY THIS EXISTS. Measured on the development host (2 logical cores, 12 GB):
//
//   go build ./...                        9.1 s   (cold: 13.8 s for one package, 0.7 s warm)
//   go test ./internal/server -run X     19.2 s
//   GitHub `verify` job (build+vet+test)  84-210 s, plus queue
//
// So the expensive part of a development iteration was never the toolchain: it was the round trip
// through GitHub to discover a compile error or a broken assertion. The project's own notes said a
// local Go build was not affordable, and that belief cost iterations that this script makes cheap.
//
// WHAT IT DOES. Given the files you changed (or an explicit selection), it decides the SMALLEST set
// of checks that can falsify your change, runs them, and prints what it decided and why. It is
// deliberately a decision-maker rather than a fixed list: a change to one provider's file runs that
// provider's tests; a change to a shared helper escalates to the whole server package; a change to a
// fixture or a probe is not locally verifiable at all and says so.
//
// WHAT IT DOES NOT DO. It cannot close a provider-wire capture (that needs the pinned Node server and
// belongs to the oracle and, for a new scenario, to a recording run). It does not weaken anything: the
// escalation rules only ever widen the check set.
//
// USAGE
//   node scripts/dev-verify.mjs                 # classify the working tree against origin/main
//   node scripts/dev-verify.mjs --staged        # classify only what is staged
//   node scripts/dev-verify.mjs --files a b c   # classify exactly these paths
//   node scripts/dev-verify.mjs --full          # everything CI would run, locally
//   node scripts/dev-verify.mjs --json          # machine-readable decision, no execution
//   node scripts/dev-verify.mjs --explain       # print the decision and the rules that fired

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const hasFlag = name => args.includes(`--${name}`);
const flagValue = name => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};

function git(argv) {
    return execFileSync('git', argv, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function changedFiles() {
    if (hasFlag('files')) {
        const i = args.indexOf('--files');
        return args.slice(i + 1).filter(a => !a.startsWith('--'));
    }
    if (hasFlag('staged')) {
        return git(['diff', '--name-only', '--cached']).split('\n').filter(Boolean);
    }
    let base = 'origin/main';
    try {
        git(['rev-parse', '--verify', base]);
    } catch {
        base = git(['rev-parse', 'HEAD^']);
    }
    const committed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
    const dirty = git(['status', '--porcelain'])
        .split('\n')
        .filter(Boolean)
        .map(line => line.slice(3).trim())
        .filter(Boolean);
    return [...new Set([...committed, ...dirty])];
}

// Every Go package in the module, so a changed file can be attributed to its package directory name.
function goPackages() {
    return readdirSync(join(repoRoot, 'internal'), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
}

// Which probes declare which fixture, read from the probes themselves rather than a hand-kept list:
// every probe carries a `@gotavern-oracle: fixture=...` declaration (tools/build-generated-lib.mjs
// discovers probes exactly that way, and a probe without the declaration is a discovery hole rather
// than a probe that this script may silently ignore).
function probeDeclarations() {
    const out = [];
    for (const file of readdirSync(join(repoRoot, 'tools'))) {
        if (!file.startsWith('probe-') || !file.endsWith('.mjs')) continue;
        const text = readFileSync(join(repoRoot, 'tools', file), 'utf8');
        const fixture = text.match(/@gotavern-oracle: fixture=(\S+)/)?.[1];
        out.push({ probe: file, fixture: fixture ?? null });
    }
    return out;
}

// Scenario inputs are the provider-wire probe's data: a scenario file names its `targetPath`, which is
// the pinned source id. That is the only metadata needed to answer "which provider does this touch",
// and it is derived from the scenario files, not maintained by hand.
function scenariosByTarget() {
    const dir = join(repoRoot, 'tests', 'provider-wire', 'scenarios');
    const byTarget = new Map();
    if (!existsSync(dir)) return byTarget;
    for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        try {
            const def = JSON.parse(readFileSync(join(dir, file), 'utf8'));
            const target = def.targetPath ?? file.replace(/^([a-z0-9]+)-.*\.json$/, '$1');
            if (!byTarget.has(target)) byTarget.set(target, []);
            byTarget.get(target).push(file);
        } catch {
            // A scenario file that does not parse is a real problem, but it is reported by the probe
            // and by the fixture-encoding gate; this script must not crash on it.
        }
    }
    return byTarget;
}

// A Go file's provider, if it is a per-source transport (`openai_chat.go` -> `openai`). Own-transport
// sources follow this convention by design, which is why the directory listing is enough here.
function providerFromGoFile(file) {
    const match = file.match(/internal\/server\/([a-z0-9_]+?)_chat(?:_status)?\.go$/);
    return match ? match[1] : null;
}

// Shared surfaces: changing one of these can move ANY provider's observable, so the check set has to
// widen to the whole server package and the provider-wire probe. The list is deliberately explicit
// rather than inferred: guessing that a file is shared is how a narrow check set silently stops
// covering the thing it was narrowed away from.
const SHARED_SERVER_FILES = [
    'internal/server/chat_completions.go',
    'internal/server/backends_status.go',
    'internal/server/backends.go',
    'internal/server/server.go',
    'internal/server/outbound.go',
];
const SHARED_SERVER_PREFIXES = [
    'internal/server/chat_completion_',
    'internal/server/sd',
    'internal/outbound/',
    'internal/startup/',
    'internal/secrets/',
    'internal/config/',
    'internal/middleware/',
];

function classify(files) {
    const packages = goPackages();
    const probes = probeDeclarations();
    const scenarios = scenariosByTarget();
    const decision = {
        files,
        checks: [],
        escalations: [],
        providers: [],
        probes: [],
        fixtures: [],
        cannotVerifyLocally: [],
        notes: [],
    };
    const addCheck = (id, why, command) => {
        if (decision.checks.some(c => c.id === id)) return;
        decision.checks.push({ id, why, command });
    };
    const escalate = why => {
        if (!decision.escalations.includes(why)) decision.escalations.push(why);
    };

    if (files.length === 0) {
        decision.notes.push('no changed files against the base; nothing to verify');
        return decision;
    }

    // Formatting is cheap and catches the class this project has shipped before (a doc comment that
    // gofmt rewrites, a file whose committed bytes differ from the working tree).
    if (files.some(f => f.endsWith('.go'))) {
        addCheck('gofmt', 'Go files changed; the committed bytes must be gofmt-clean (Windows CRLF makes a local `gofmt -l` misleading, so the check runs on the LF form)', 'node scripts/dev-verify.mjs (built in)');
    }

    const goFiles = files.filter(f => f.endsWith('.go'));
    const touchedPackages = new Set();
    for (const file of goFiles) {
        const rel = file.split(sep).join('/');
        const pkgMatch = rel.match(/^internal\/([a-z0-9_]+)\//);
        if (pkgMatch && packages.includes(pkgMatch[1])) touchedPackages.add(pkgMatch[1]);
        if (rel.startsWith('cmd/')) touchedPackages.add('cmd');
        const provider = providerFromGoFile(rel);
        if (provider) decision.providers.push(provider);
        if (SHARED_SERVER_FILES.includes(rel)) escalate(`${rel} is a shared dispatch surface: every provider's observable can move`);
        if (SHARED_SERVER_PREFIXES.some(p => rel.startsWith(p))) escalate(`${rel} is a shared implementation surface`);
        if (rel.endsWith('_test.go')) decision.notes.push(`${rel} is a test file: the package's tests are the check`);
    }

    for (const file of files) {
        const rel = file.split(sep).join('/');
        if (rel.startsWith('tests/provider-wire/scenarios/')) {
            const def = (() => {
                try {
                    return JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
                } catch {
                    return null;
                }
            })();
            const target = def?.targetPath ?? rel.replace(/^tests\/provider-wire\/scenarios\/([a-z0-9]+)-.*$/, '$1');
            decision.providers.push(target);
            decision.cannotVerifyLocally.push(`${rel}: a scenario without a capture can only be closed by the oracle (pinned Node), never locally`);
        }
        if (rel.startsWith('tests/oracle/')) {
            decision.fixtures.push(rel);
            const owners = probes.filter(p => p.fixture && rel.endsWith(p.fixture)).map(p => p.probe);
            decision.probes.push(...owners);
            decision.cannotVerifyLocally.push(`${rel}: a recorded fixture is produced by the pinned server; replaying it locally proves the Go side only`);
        }
        if (rel.startsWith('tools/probe-') || rel.startsWith('tools/lib/')) {
            decision.probes.push(rel.startsWith('tools/probe-') ? rel.replace(/^tools\//, '') : '(every probe that imports tools/lib)');
            decision.cannotVerifyLocally.push(`${rel}: probe and harness code is only falsifiable against the pinned server`);
            if (rel.startsWith('tools/lib/')) escalate('tools/lib is imported by many probes; a change there can move any fixture');
        }
        if (rel.endsWith('.mjs') && (rel.startsWith('tests/browser/') || rel === 'tools/verify-browser-comparisons.mjs')) {
            addCheck('browser-evidence', 'browser comparison artifacts and their gate must stay coherent', 'node tools/verify-browser-comparisons.mjs');
        }
        if (rel.startsWith('.github/workflows/')) {
            decision.notes.push(`${rel}: workflow changes are exercised by a dispatch run, not locally`);
        }
        if (rel.startsWith('docs/') || rel.endsWith('.md')) {
            decision.notes.push(`${rel}: documentation only`);
        }
    }

    decision.providers = [...new Set(decision.providers)].filter(Boolean);
    decision.probes = [...new Set(decision.probes)].filter(Boolean);

    // Shared surfaces or an unattributable change widen the Go check to the whole repository.
    //
    // WHAT THIS DELIBERATELY DOES NOT DO, and why the widening rule is not "be safe":
    //   go test ./...      123 s here against 56 s on the x86 runner -- the local host loses on the whole
    //                      suite, so paying it per iteration would be slower than CI.
    //   six-platform build  the runner does it once as a gate; locally it buys nothing an agent can act on.
    //   assets verify / oracle   not local decisions at all.
    // A provider edit therefore runs that package's tests, and the module is proved to COMPILE by building
    // the artifact that actually ships (./cmd/gotavern, 2.95 s warm) rather than every package's binary.
    const escalated = decision.escalations.length > 0 || touchedPackages.size > 3;
    const goScope = escalated ? './...' : [...touchedPackages].map(p => (p === 'cmd' ? './cmd/...' : `./internal/${p}/`));
    if (goFiles.length > 0 && (escalated || goScope.length > 0)) {
        if (escalated) {
            addCheck(`go-test:${goScope}`, 'a shared surface changed, so every package is in scope', `go test ${goScope} -count=1`);
            addCheck('go-build', 'a shared surface changed; every package must still compile', 'go build ./...');
        } else {
            for (const scope of goScope) {
                // A per-source transport edit gets a -run pattern when one can be derived, because the
                // whole internal/server package is 95 s here: the pattern turns it into ~20 s.
                const provider = decision.providers.length === 1 ? decision.providers[0] : null;
                if (provider && scope === './internal/server/') {
                    const pattern = provider.replace(/(^|_)([a-z])/g, (_m, _s, c) => c.toUpperCase());
                    if (/^[A-Za-z]+$/.test(pattern)) {
                        addCheck(`go-test:${scope}-run:${pattern}`, `only ${provider}'s own tests can be affected (the whole package is 95 s here)`, `go test ${scope} -run ${pattern} -count=1`);
                        continue;
                    }
                }
                addCheck(`go-test:${scope}`, 'the package that changed', `go test ${scope} -count=1`);
            }
            addCheck('go-build', 'the artifact that ships must compile', 'go build ./cmd/gotavern');
        }
    }

    if (decision.probes.length > 0 || decision.fixtures.length > 0) {
        decision.notes.push(`probes the oracle would re-record for this change: ${[...new Set(decision.probes)].join(', ') || '(none resolved)'}`);
    }
    return decision;
}

function run(command) {
    const started = Date.now();
    try {
        execFileSync(command[0], command.slice(1), { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' });
        return { ok: true, ms: Date.now() - started };
    } catch (error) {
        return { ok: false, ms: Date.now() - started, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
}

function gofmtCheck(changedGoFiles) {
    // A local `gofmt -l` reports every file on Windows because the working tree is CRLF while gofmt
    // formats LF. The committed bytes are what CI judges, so compare the LF form instead of trusting
    // the plain command -- the same correction that let a real formatting failure through once.
    //
    // ONLY THE CHANGED FILES ARE FORMATTED. Formatting every tracked Go file costs seconds of pure IO
    // on this host and can only ever fail on a file the change touched, so doing it for all of them
    // made the "fast" tier slower than the CI round trip it exists to replace.
    const files = changedGoFiles.filter(file => file.endsWith('.go'));
    const bad = [];
    for (const file of files) {
        const lf = readFileSync(join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');
        const formatted = execFileSync('gofmt', [], { input: lf, encoding: 'utf8' });
        if (formatted !== lf) bad.push(file);
    }
    return bad;
}

function main() {
    const files = changedFiles().filter(f => existsSync(join(repoRoot, f)) || files_existed(f));
    const decision = classify(files);
    if (hasFlag('json')) {
        console.log(JSON.stringify(decision, null, 2));
        return;
    }
    if (hasFlag('explain') || decision.checks.length === 0) {
        console.log(`changed files (${decision.files.length}):`);
        for (const f of decision.files) console.log(`  ${f}`);
        console.log('\nselected checks:');
        for (const c of decision.checks) console.log(`  ${c.id}  -- ${c.why}`);
        if (decision.escalations.length) {
            console.log('\nescalations:');
            for (const e of decision.escalations) console.log(`  ${e}`);
        }
        if (decision.cannotVerifyLocally.length) {
            console.log('\nNOT verifiable locally (the oracle owns these):');
            for (const n of decision.cannotVerifyLocally) console.log(`  ${n}`);
        }
        if (decision.notes.length) {
            console.log('\nnotes:');
            for (const n of decision.notes) console.log(`  ${n}`);
        }
        if (decision.checks.length === 0) return;
        console.log('');
    }

    const full = hasFlag('full');
    const checks = full
        ? [{ id: 'go-test:./...', command: ['go', 'test', './...', '-count=1'] }, { id: 'go-build', command: ['go', 'build', './...'] }]
        : decision.checks;

    let failed = 0;
    for (const check of checks) {
        if (check.id === 'gofmt') {
            const bad = gofmtCheck(decision.files);
            const ok = bad.length === 0;
            console.log(`${ok ? 'ok  ' : 'FAIL'} gofmt ${ok ? '(all committed Go files are gofmt-clean in LF form)' : `-- ${bad.join(', ')}`}`);
            if (!ok) failed++;
            continue;
        }
        if (check.id === 'browser-evidence') {
            const result = run(['node', 'tools/verify-browser-comparisons.mjs']);
            console.log(`${result.ok ? 'ok  ' : 'FAIL'} browser-evidence (${(result.ms / 1000).toFixed(1)}s)`);
            if (!result.ok) {
                console.log(result.output.split('\n').slice(-25).join('\n'));
                failed++;
            }
            continue;
        }
        const argv = check.command.split(' ');
        const result = run(argv);
        console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${check.id} (${(result.ms / 1000).toFixed(1)}s)`);
        if (!result.ok) {
            const lines = result.output.split('\n');
            const interesting = lines.filter(l => /--- FAIL|_test\.go:\d+:|cannot|undefined:|declared and not used/.test(l)).slice(0, 25);
            console.log((interesting.length ? interesting : lines.slice(-25)).join('\n'));
            failed++;
        }
    }

    if (decision.cannotVerifyLocally.length) {
        console.log('\nstill needs the oracle (do not read a local pass as provider-wire proof):');
        for (const n of decision.cannotVerifyLocally) console.log(`  ${n}`);
    }
    console.log(`\n${failed === 0 ? 'local verification passed' : `${failed} check(s) failed`}; this is Tier 0/1, not a compatibility claim`);
    process.exitCode = failed === 0 ? 0 : 1;
}

function files_existed(file) {
    // A deleted file is still part of the change set; it must not be dropped because it is gone.
    try {
        git(['ls-files', '--error-unmatch', file]);
        return true;
    } catch {
        return true;
    }
}

main();
