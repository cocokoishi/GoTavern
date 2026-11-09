// a19-live-oracle.mjs -- the alpha.19 LIVE ORACLE driver: boot BOTH subjects over COPIES of ONE immutable
// corpus, run the SAME journey on both, record the five observable layers, judge them, and prove the judge
// has teeth.
//
// WHAT IT ORCHESTRATES (one process, one command -- the pattern longlived-qualify.mjs already proved):
//   1. CENSUS the corpus and (when supplied) verify its published manifest digest. The corpus is an
//      INPUT: it is never booted and never written (AGENTS hard rules 14/51).
//   2. COPY it once per subject and verify each copy's census equals the source census by name.
//   3. BOOT each subject over its own copy, sequentially (never two servers on one writable tree):
//      GoTavern via q20-leg-runtime.bootSubject (browserLaunchEnabled false, tokenizer layout enforced,
//      identity-bound readiness); pinned via run-against-pinned.mjs (same flag, same seeded config).
//   4. RUN the same journey probe on both, with the driver's recording peer and a per-subject reply
//      prefix, so the two subjects are provably driven the same way and provably fed different replies
//      (rule 50). The probe records layers A/B/D/E; the peer records layer C.
//   5. PHASES: `drive`, then `restart` over the SAME tree; then two HAND-BACKS (a copy of the GoTavern
//      tree booted by pinned, and a copy of the pinned tree booted by GoTavern), each proving the other
//      backend reads what was written (Node -> Go -> Node, both directions).
//   6. JUDGE with a19-compare-live-oracle.mjs (five layer guard groups, taxonomy verdicts, a normalisation
//      registry whose entries each carry reason/pinned evidence/field/test/negative case).
//   7. TEETH with a19-oracle-teeth.mjs: mutate THIS run's own leg artifacts, one per named guard, and
//      require every named guard to go red on top of a green baseline.
//
// TWO MODES, AND THE LABEL IS ENFORCED:
//   --corpus-origin ui      the real Node-UI-Originated Corpus (Subagent A). Emits the evidence-contract
//                           artifact `a19-real-ui-oracle-evidence.json` (schema a19-real-ui-oracle-v1).
//   (default) self-check    any stand-in corpus (today: the synthetic long-lived small corpus). Emits
//                           `a19-self-check-verdict.json` with kind "harness-self-check" and REFUSES to
//                           emit the real artifact. This keeps "synthetic stand-in is not the oracle"
//                           un-losable, per the Lead's instruction.
//
// JOURNEY CONTRACT (A's a19-journey-probe.mjs must accept this; the self-check probe does):
//   node <journey> --base-url <url> --data-root <tree> --phase drive|restart --peer-url <url>
//                  --reply-prefix <P> --report <path>
//   * --base-url / PROBE_BASE_URL present => DO NOT boot a server (the driver owns the process).
//   * --peer-url present => configure the page to it and DO NOT start a peer.
//   * the report is schema `a19-live-oracle-leg-v1` (a19-oracle-kit.mjs emptyLeg).
//
// SAFETY: no desktop browser may launch. The driver asserts the three literals that guarantee it (same
// check longlived-qualify.mjs uses) before doing anything, and refuses otherwise.
//
// USAGE:
//   GOTAVERN_BINARY=<candidate> node tests/browser/a19-live-oracle.mjs \
//     --corpus <immutable corpus> --out-dir <scratch run dir> [--corpus-manifest <sha256|json>] \
//     [--journey tests/browser/a19-journey-selfcheck.mjs] [--phases drive,restart] [--skip-pinned]
//     [--head-sha <candidate SHA>] [--mode all] [--corpus-tier <tier>]
//   (--out-dir is accepted as an alias of --out.)
// Env: GOTAVERN_REFERENCE (pinned checkout), PINNED_READY_MS (default 300000 locally), A19_CORPUS_ORIGIN.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    assertOriginalUnchanged, censusDiff, censusTree, copyCorpusVerified,
    providerWireLayer, readJson, sha256, startWirePeer, writeJson,
} from './a19-oracle-kit.mjs';
import { bootSubject, freePort } from './q20-leg-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}
const hasFlag = name => process.argv.includes(name);

function run(command, args, { cwd = repoRoot, env = process.env } = {}) {
    return new Promise(resolve => {
        const started = Date.now();
        const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
        child.on('error', error => resolve({ code: 1, error: String(error?.message ?? error), elapsedMs: Date.now() - started }));
        child.on('exit', (code, signal) => resolve({ code: code ?? 1, signal, error: null, elapsedMs: Date.now() - started }));
    });
}

/**
 * Refuse to start when any of the three literals that keep a DESKTOP browser from launching is missing.
 * They live in files this driver does not own, so they are asserted at the entry point (the pattern
 * longlived-qualify.mjs introduced). The journey may be A's probe; the driver cannot assume its content,
 * so the two subject wrappers are checked here and the journey's headless launch is checked when the
 * journey is the self-check probe.
 */
async function assertNoDesktopBrowserCanLaunch(journeyPath) {
    const checks = [
        { file: path.join(here, 'q20-leg-runtime.mjs'), needle: "'--browserLaunchEnabled'", why: 'the GoTavern boot must pass --browserLaunchEnabled false' },
        { file: path.join(here, 'run-against-pinned.mjs'), needle: "'--browserLaunchEnabled'", why: 'the pinned boot must pass --browserLaunchEnabled false' },
    ];
    if (path.basename(journeyPath) === 'a19-journey-selfcheck.mjs') {
        checks.push({ file: journeyPath, needle: 'chromium.launch({ headless: true })', why: 'the self-check journey must launch Playwright explicitly headless' });
        checks.push({ file: journeyPath, needle: '--peer-url', why: 'the self-check journey must not invent a peer' });
    }
    const failures = [];
    for (const check of checks) {
        const body = await fs.readFile(check.file, 'utf8').catch(() => '');
        if (!body.includes(check.needle)) failures.push({ file: path.relative(repoRoot, check.file), needle: check.needle, why: check.why });
    }
    if (failures.length > 0) throw new Error(`REFUSING TO RUN: a desktop-browser launch guard is missing: ${JSON.stringify(failures)}`);
    return checks.map(check => path.relative(repoRoot, check.file));
}

/**
 * REUSE THE PINNED SERVER'S COMPILED FRONTEND when a second pinned tree is booted.
 *
 * Pinned compiles its frontend into <dataRoot>/_webpack on the FIRST boot of a tree; measured on this host
 * (2026-11-08) that compile alone was 151 s, and each hand-back direction needs a FRESH copy of the other
 * subject's tree. `_webpack`/`_cache` are pinned build/cache artefacts (the persistence comparison already
 * excludes them as a named normalisation), so copying them from an already-booted pinned tree is a harness
 * warm start, not a change to the input data: the corpus files themselves are the verified copies.
 */
async function warmPinnedTreeFrom(target, sourceTree) {
    const warmed = [];
    for (const name of ['_webpack', '_cache']) {
        const from = path.join(sourceTree, name);
        try {
            await fs.stat(from);
            await fs.cp(from, path.join(target, name), { recursive: true });
            warmed.push(name);
        } catch { /* not compiled yet; the boot will pay the compile */ }
    }
    return warmed;
}

async function pinnedCommit(reference) {
    const result = spawnSync('git', ['-C', reference, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Verify the corpus against a published manifest IF one is supplied. Two accepted shapes:
 *   * the shared-schema/corpus manifest JSON carrying `tree.sha256` (the long-lived corpus shape);
 *   * a `sha256sum`-style text file of `<hex>  <relative path>` lines.
 * With no manifest the census is still recorded (self-check mode) and the verdict says so.
 */
async function verifyCorpusManifest(manifestPath, census) {
    if (!manifestPath) return { verified: false, manifestPath: null, manifestSha256: null, reason: 'no --corpus-manifest supplied; the census is recorded but no published digest was checked', observedTreeSha256: census.treeSha256 };
    const bytes = await fs.readFile(manifestPath);
    const text = bytes.toString('utf8');
    const manifestSha256 = sha256(bytes);
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
        const document = JSON.parse(trimmed);
        // THE alpha.19 CORPUS MANIFEST SHAPE (Lead/A contract, 2026-11-08): schema
        // "a19-corpus-manifest-v1", corpus.{origin,tier}, files, bytes, treeSha256, counts, inventory[].
        // The treeSha256 is sha256 over the sorted `<sha256>  <path>` lines of EVERY file under the data
        // root, with no trailing newline -- exactly what censusTree computes -- and the finalizer writes the
        // manifest OUTSIDE the data root, so there is no self-referential entry to exclude.
        const problems = [];
        if (typeof document?.schema === 'string' && document.schema !== 'a19-corpus-manifest-v1') {
            problems.push(`manifest schema is ${JSON.stringify(document.schema)}, expected "a19-corpus-manifest-v1"`);
        }
        const declaredTree = document?.treeSha256 ?? document?.tree?.sha256 ?? document?.corpusTreeSha256 ?? document?.digest ?? document?.corpus?.treeSha256 ?? null;
        const declaredFiles = document?.files ?? document?.fileCount ?? document?.counts?.files ?? document?.corpus?.files ?? document?.tree?.files ?? null;
        const declaredBytes = document?.bytes ?? document?.byteCount ?? document?.counts?.bytes ?? document?.corpus?.bytes ?? document?.tree?.bytes ?? null;
        if (declaredTree === null) problems.push('the manifest JSON carries no treeSha256');
        else if (declaredTree !== census.treeSha256) problems.push(`declared treeSha256 ${declaredTree} != walked ${census.treeSha256}`);
        if (declaredFiles === null) problems.push('the manifest JSON carries no files count');
        else if (Number(declaredFiles) !== census.fileCount) problems.push(`declared files ${declaredFiles} != walked ${census.fileCount}`);
        if (declaredBytes === null) problems.push('the manifest JSON carries no bytes count');
        else if (Number(declaredBytes) !== census.bytes) problems.push(`declared bytes ${declaredBytes} != walked ${census.bytes}`);
        // THE INVENTORY IS CHECKED BOTH WAYS: a missing file, an extra file and a per-file sha256 mismatch are
        // three different defects and each is named (a manifest that only counted would miss a swap).
        let inventoryEntries = null;
        if (Array.isArray(document?.inventory)) {
            inventoryEntries = document.inventory.length;
            const declared = new Map();
            for (const entry of document.inventory) {
                if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') continue;
                declared.set(entry.path.replace(/\\/g, '/'), { sha256: entry.sha256, bytes: Number(entry.bytes ?? -1) });
            }
            const walked = new Map(census.files.map(file => [file.path, file]));
            for (const [filePath, file] of walked) {
                const entry = declared.get(filePath);
                if (!entry) problems.push(`inventory is missing ${filePath}`);
                else if (entry.sha256 !== file.sha256) problems.push(`inventory sha256 differs for ${filePath}`);
            }
            for (const filePath of declared.keys()) {
                if (!walked.has(filePath)) problems.push(`inventory lists a file the corpus does not have: ${filePath}`);
            }
        }
        return {
            // TRUE ONLY AFTER THE WHOLE COMPARISON PASSED; the Lead's verifier requires exactly boolean true.
            verified: problems.length === 0 && declaredTree !== null,
            manifestPath,
            manifestSha256,
            schema: document?.schema ?? null,
            corpusOrigin: document?.corpus?.origin ?? null,
            tier: document?.corpus?.tier ?? null,
            declaredTreeSha256: declaredTree,
            declaredFiles: declaredFiles === null ? null : Number(declaredFiles),
            declaredBytes: declaredBytes === null ? null : Number(declaredBytes),
            inventoryEntries,
            counts: document?.counts ?? null,
            observedTreeSha256: census.treeSha256,
            observedFiles: census.fileCount,
            observedBytes: census.bytes,
            problems,
            reason: problems.length === 0 ? null : 'the manifest does not describe the walked corpus',
        };
    }
    const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
    const byPath = new Map();
    for (const line of lines) {
        const match = /^([0-9a-f]{64})\s{1,2}\*?(.+)$/.exec(line);
        if (!match) continue;
        byPath.set(match[2].replace(/\\/g, '/').replace(/^\.\//, ''), match[1]);
    }
    const problems = [];
    for (const file of census.files) {
        const declared = byPath.get(file.path);
        if (declared === undefined) problems.push(`missing from manifest: ${file.path}`);
        else if (declared !== file.sha256) problems.push(`sha256 differs: ${file.path}`);
    }
    for (const manifestPathName of byPath.keys()) {
        if (!census.files.some(file => file.path === manifestPathName)) problems.push(`manifest lists a file the corpus does not have: ${manifestPathName}`);
    }
    return { verified: problems.length === 0 && byPath.size > 0, manifestPath, manifestSha256, entries: byPath.size, problems, observedTreeSha256: census.treeSha256, reason: byPath.size === 0 ? 'the manifest text has no parsable <sha256>  <path> lines' : null };
}

/**
 * Run one leg: start the recording peer, boot/hand over the subject, spawn the journey, then collect the
 * provider-wire layer from the peer. A boot refusal or a journey failure is recorded in the leg and does
 * NOT abort the other legs (all legs must be attempted, or the repair loop pays for the same partial run).
 */
async function runLeg({ subject, phase, tree, corpusCensus, persistenceBaseline, journeyPath, outDir, goBinary, reference, pinnedCommitHash }) {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const reportPath = path.join(outDir, 'legs', `a19-${phase}-${subject}.json`);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    const peer = await startWirePeer({ replyPrefix: subject === 'gotavern' ? 'A19G_' : 'A19P_' });
    const leg = {
        schema: 'a19-live-oracle-leg-v1',
        subject, phase, journey: path.basename(journeyPath),
        corpusTreeSha256: corpusCensus.treeSha256,
        startedAt, finishedAt: null,
        baseURL: null, peerURL: peer.url, wireMode: peer.wireMode, replyPrefix: peer.replyPrefix,
        steps: [], failure: null, bootRefusal: null, serverPid: null, elapsedMs: null,
        layers: { browser: null, http: null, providerWire: null, persistence: null, lifecycle: null },
    };
    const journeyArgs = [
        '--data-root', tree,
        '--phase', phase,
        '--peer-url', peer.url,
        '--reply-prefix', peer.replyPrefix,
        '--subject', subject,
        '--report', reportPath,
    ];
    try {
        if (subject === 'gotavern') {
            const port = await freePort();
            const boot = await bootSubject({ argv: process.argv.slice(2), dataRoot: tree, port, external: false });
            leg.baseURL = boot.baseURL;
            leg.serverPid = boot.server?.pid ?? null;
            leg.bootRefusal = boot.bootRefusal;
            if (boot.bootRefusal) {
                leg.steps.push({ name: 'boot', ok: false, detail: boot.bootRefusal });
            } else {
                leg.steps.push({ name: 'boot', ok: true, detail: { port, pid: boot.server?.pid ?? null, tokenizers: boot.tokenizers?.layout ?? null, tokenizersCopied: boot.tokenizers?.copied ?? null } });
                const child = await run(process.execPath, [journeyPath, '--base-url', boot.baseURL, ...journeyArgs], { env: { ...process.env, PROBE_BASE_URL: boot.baseURL, PROBE_SERVER_PID: String(boot.server?.pid ?? ''), A19_TURN_MARKER: 'A19_SELFCHECK_TURN' } });
                leg.steps.push({ name: 'journey', ok: child.code === 0, detail: { exitCode: child.code, elapsedMs: child.elapsedMs } });
                try { boot.server?.kill?.('SIGKILL'); } catch { /* already gone */ }
            }
        } else {
            const forwarded = ['--data-root', tree, '--phase', phase, '--peer-url', peer.url, '--reply-prefix', peer.replyPrefix, '--subject', subject, '--report', reportPath];
            const child = await run(process.execPath, [path.join(here, 'run-against-pinned.mjs'), journeyPath, '--', ...forwarded], {
                env: { ...process.env, GOTAVERN_REFERENCE: reference, PINNED_READY_MS: process.env.PINNED_READY_MS ?? '600000', A19_TURN_MARKER: 'A19_SELFCHECK_TURN' },
            });
            leg.steps.push({ name: 'journey', ok: child.code === 0, detail: { exitCode: child.code, elapsedMs: child.elapsedMs } });
            leg.baseURL = 'http://127.0.0.1:<pinned-port>';
        }
    } catch (error) {
        leg.failure = String(error?.message ?? error).slice(0, 2000);
        leg.steps.push({ name: 'driver', ok: false, detail: leg.failure });
    } finally {
        await peer.close().catch(() => {});
    }
    leg.layers.providerWire = providerWireLayer(peer);
    // The journey's own report carries A/B/D/E; merge it rather than overwrite, and refuse to treat a
    // missing report as a pass.
    let journeyReport = null;
    try { journeyReport = await readJson(reportPath); } catch { journeyReport = null; }
    if (journeyReport) {
        leg.steps.push(...(journeyReport.steps ?? []));
        leg.layers.browser = journeyReport.layers?.browser ?? null;
        leg.layers.http = journeyReport.layers?.http ?? null;
        leg.layers.persistence = journeyReport.layers?.persistence ?? null;
        leg.layers.lifecycle = journeyReport.layers?.lifecycle ?? null;
        if (journeyReport.failure) leg.failure = journeyReport.failure;
        if (journeyReport.peerURL) leg.peerURL = journeyReport.peerURL;
    } else {
        leg.steps.push({ name: 'journey-report', ok: false, detail: 'the journey wrote no leg report; nothing can be compared from it' });
        if (leg.failure === null) leg.failure = 'the journey wrote no leg report';
    }
    // The persistence layer's DIFF against the immutable corpus census: created/modified/deleted, named.
    if (leg.layers.persistence?.tree) {
        leg.persistenceDiff = censusDiff(persistenceBaseline ?? corpusCensus, leg.layers.persistence.tree);
        // THE PRODUCT-SURFACE JSON TEXT, enriched by the driver because the journey probe records only the tree
        // census. The comparator applies its NAMED projections (per-leg peer endpoint, random ids, timings,
        // image-metadata addedTimestamp) to these documents; without the text it would fall back to raw digests
        // that differ for harness reasons.
        const jsonFiles = [];
        for (const relative of ['default-user/settings.json', 'default-user/image-metadata.json']) {
            try {
                const text = await fs.readFile(path.join(tree, relative), 'utf8');
                if (text.length <= 4 * 1024 * 1024) jsonFiles.push({ path: relative, text });
            } catch { /* absent is reported by the guards */ }
        }
        if (leg.layers.persistence) leg.layers.persistence.jsonFiles = jsonFiles;
    }
    leg.pinnedCommit = subject === 'pinned' ? pinnedCommitHash : null;
    leg.finishedAt = new Date().toISOString();
    leg.elapsedMs = Date.now() - startedMs;
    leg.failedSteps = leg.steps.filter(step => step.ok !== true).map(step => step.name);
    if (leg.failure === null && leg.failedSteps.length > 0) leg.failure = `drive steps did not hold: ${leg.failedSteps.join(', ')}`;
    await writeJson(reportPath, leg);
    return leg;
}

function overallVerdict(comparison) {
    const layers = comparison?.layers ?? {};
    const verdicts = Object.values(layers).map(layer => layer.verdict);
    if (verdicts.length === 0) return 'not-observed';
    if (verdicts.some(verdict => verdict === 'mismatch' || verdict === 'candidate-error')) return 'mismatch';
    if (verdicts.some(verdict => verdict === 'harness-error')) return 'harness-error';
    if (verdicts.some(verdict => verdict === 'not-observed' || verdict === 'pinned-unreachable')) return 'not-observed';
    return 'match';
}

async function main() {
    const corpusRoot = path.resolve(argument('--corpus', '') ?? '');
    if (!corpusRoot || corpusRoot === path.resolve('')) throw new Error('--corpus is required: the immutable corpus root');
    const outDir = path.resolve(argument('--out', argument('--out-dir', path.join(here, '.tmp-artifacts', 'a19-live-oracle'))));
    const headSha = argument('--head-sha', process.env.GITHUB_SHA ?? spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? '');
    const corpusTier = argument('--corpus-tier', null);
    const journeyPath = path.resolve(argument('--journey', path.join(here, 'a19-journey-selfcheck.mjs')));
    const manifestPath = argument('--corpus-manifest', null);
    const corpusOrigin = argument('--corpus-origin', process.env.A19_CORPUS_ORIGIN ?? 'synthetic-stand-in');
    // THE SELF-CHECK/CORPUS-ORIGIN DECISION COMES BEFORE THE MODE, which names it.
    const selfCheck = corpusOrigin !== 'ui';
    // THE CI CONTRACT'S `--mode all`: the release artifact must say which oracle ran, and a narrowed mode
    // must never produce release evidence. Only `all` is accepted in release mode; the self-check has its
    // own mode name and never writes the release artifact.
    const mode = argument('--mode', selfCheck ? 'self-check' : 'all');
    if (mode !== 'all' && !selfCheck) throw new Error(`--mode ${JSON.stringify(mode)} is not accepted: release evidence requires --mode all (a narrowed oracle must not ship as the full one)`);
    const skipPinned = hasFlag('--skip-pinned');
    const phases = (argument('--phases', 'drive,restart') ?? 'drive,restart').split(',').map(value => value.trim()).filter(Boolean);
    const goBinary = process.env.GOTAVERN_BINARY ?? '';
    if (!goBinary) throw new Error('GOTAVERN_BINARY is required: this driver boots the CANDIDATE binary');
    const reference = process.env.GOTAVERN_REFERENCE ?? path.resolve(repoRoot, '..', 'SillyTavern');
    const pinnedCommitHash = skipPinned ? null : await pinnedCommit(reference);
    await fs.mkdir(outDir, { recursive: true });

    const runStartedAt = new Date().toISOString();
    // THE EVIDENCE DOCUMENT. In real mode it is EXACTLY the document scripts/verify-a19-evidence.mjs
    // validates (schemaVersion/kind/headSha/pinnedCommit/ok/corpus/selection/layers/normalisations/
    // notCompared/startedAt/finishedAt); in self-check mode it is a DIFFERENT kind and a DIFFERENT file
    // name, so a self-check artifact can never be mistaken for release evidence (the Lead's requirement).
    const verdict = {
        schemaVersion: 1,
        kind: selfCheck ? 'harness-self-check' : 'a19-real-ui-oracle-v1',
        // THE LABEL IS PART OF THE ARTIFACT, and the driver refuses to drop it in self-check mode.
        label: selfCheck ? 'harness self-check; synthetic stand-in, NOT the alpha.19 oracle' : 'alpha.19 real-UI oracle',
        releaseAdmissible: !selfCheck,
        headSha,
        pinnedCommit: pinnedCommitHash,
        corpusOrigin,
        startedAt: runStartedAt,
        finishedAt: null,
        selection: { mode: selfCheck ? 'self-check' : mode, dispatch: process.env.GITHUB_EVENT_NAME ?? 'local', corpusTier: corpusTier ?? (selfCheck ? 'self-check' : 'full'), journey: path.basename(journeyPath), phases, pinned: !skipPinned },
        corpus: null,
        legs: [],
        layers: null,
        normalisations: [],
        notCompared: [],
        guardsChecked: [],
        ok: false,
    };

    try {
        verdict.guardsChecked = await assertNoDesktopBrowserCanLaunch(journeyPath);
    } catch (error) {
        verdict.error = String(error?.message ?? error);
        await writeJson(path.join(outDir, selfCheck ? 'a19-self-check-verdict.json' : 'release-evidence.json'), verdict);
        console.error(verdict.error);
        process.exit(1);
    }

    // ---- 1. THE IMMUTABLE CORPUS.
    const fullCensus = await censusTree(corpusRoot);
    if (fullCensus.fileCount === 0) throw new Error(`the corpus at ${corpusRoot} is empty; nothing to drive`);
    // The corpus IDENTITY is the generator's own rule: a root `manifest.json` is governance, not content, so
    // the declared tree digest excludes it (docs/longlived-corpus.md §1). The full census is still what the
    // copies are verified against and what the persistence diff is taken from.
    const corpusCensus = fullCensus.files.some(file => file.path === 'manifest.json')
        ? await censusTree(corpusRoot, { excludePaths: ['manifest.json'] })
        : fullCensus;
    const manifest = await verifyCorpusManifest(manifestPath, corpusCensus);
    // THE EVIDENCE-CONTRACT SHAPE: corpus.{origin,manifestSha256,files,bytes}; the walked identity and the
    // manifest verification detail ride along under `corpus.detail` for a reader.
    verdict.corpus = {
        origin: corpusOrigin,
        manifestSha256: manifest.manifestSha256 ?? sha256(Buffer.from(corpusCensus.treeSha256, 'utf8')),
        files: fullCensus.fileCount,
        bytes: fullCensus.bytes,
        detail: {
            root: corpusRoot,
            treeSha256: corpusCensus.treeSha256,
            fullTreeSha256: fullCensus.treeSha256,
            digestExcludes: corpusCensus.digestExcludes,
            manifest: manifest.manifestPath ? path.basename(manifest.manifestPath) : null,
            manifestVerification: manifest.verified === true,
            manifestCheck: manifest,
        },
    };
    // The manifest's own tier (A's finalize output) is the default; --corpus-tier overrides it.
    verdict.selection.corpusTier = corpusTier ?? manifest.tier ?? (selfCheck ? 'self-check' : 'full');
    if (!selfCheck && manifest.corpusOrigin !== null && manifest.corpusOrigin !== 'ui') {
        throw new Error(`--corpus-origin ui was requested but the manifest declares corpus.origin=; a non-UI corpus is not the alpha.19 oracle`);
    }
    if (!selfCheck && !(manifest.verified === true)) {
        throw new Error(`--corpus-origin ui requires a verified --corpus-manifest (a moved or unverified corpus must not be driven): ${JSON.stringify(manifest.problems ?? manifest.reason)}`);
    }

    // ---- 2. THE COPIES.
    const subjectsDir = path.join(outDir, 'subjects');
    const goTree = path.join(subjectsDir, 'gotavern');
    const pinnedTree = path.join(subjectsDir, 'pinned');
    const goCensus = await copyCorpusVerified(corpusRoot, goTree, fullCensus);
    const pinnedCensus = await copyCorpusVerified(corpusRoot, pinnedTree, fullCensus);
    verdict.copies = { gotavern: goCensus.treeSha256, pinned: pinnedCensus.treeSha256 };

    // ---- 3/4. THE LEGS, sequentially. A restart leg runs over the SAME tree its drive leg wrote.
    const legs = {};
    for (const phase of phases) {
        for (const subject of ['gotavern', 'pinned']) {
            if (subject === 'pinned' && skipPinned) {
                legs[`${phase}-${subject}`] = { skipped: true, reason: '--skip-pinned (triage only; the verdict is NOT a pass)' };
                continue;
            }
            const tree = subject === 'gotavern' ? goTree : pinnedTree;
            const leg = await runLeg({ subject, phase, tree, corpusCensus, persistenceBaseline: fullCensus, journeyPath, outDir, goBinary, reference, pinnedCommitHash });
            legs[`${phase}-${subject}`] = leg;
            verdict.legs.push({
                subject, phase, exitCode: leg.failure === null ? 0 : 1, elapsedMs: leg.elapsedMs,
                report: path.relative(outDir, path.join(outDir, 'legs', `a19-${phase}-${subject}.json`)),
                failedSteps: leg.failedSteps, failure: leg.failure, serverPid: leg.serverPid,
            });
            console.error(`[a19-live-oracle] ${subject}/${phase}: ${leg.failure === null ? 'drove' : `FAILED (${leg.failure.slice(0, 160)})`} in ${leg.elapsedMs} ms`);
        }
    }

    // ---- 5. HAND-BACKS: each subject boots a COPY of the OTHER subject's written tree and resumes it.
    const handback = {};
    if (!skipPinned) {
        const handbackDir = path.join(subjectsDir, 'handback');
        const directions = [
            { name: 'pinned-reads-gotavern-tree', subject: 'pinned', source: goTree, prefix: 'A19HB_P_' },
            { name: 'gotavern-reads-pinned-tree', subject: 'gotavern', source: pinnedTree, prefix: 'A19HB_G_' },
        ];
        for (const direction of directions) {
            const tree = path.join(handbackDir, direction.name);
            await copyCorpusVerified(direction.source, tree, await censusTree(direction.source));
            // Pinned compiles its frontend on a fresh tree; reuse the compiled tree from the drive leg so the
            // hand-back measures the hand-back rather than paying a 150 s webpack build again.
            if (direction.subject === 'pinned') await warmPinnedTreeFrom(tree, pinnedTree);
            const started = Date.now();
            const reportPath = path.join(outDir, 'legs', `a19-handback-${direction.subject}.json`);
            const peer = await startWirePeer({ replyPrefix: direction.prefix });
            const journeyArgs = ['--data-root', tree, '--phase', 'restart', '--peer-url', peer.url, '--reply-prefix', direction.prefix, '--subject', direction.subject, '--report', reportPath];
            let exitCode = 1;
            let refusal = null;
            if (direction.subject === 'gotavern') {
                const port = await freePort();
                const boot = await bootSubject({ argv: process.argv.slice(2), dataRoot: tree, port, external: false });
                refusal = boot.bootRefusal;
                if (!boot.bootRefusal) {
                    const child = await run(process.execPath, [journeyPath, '--base-url', boot.baseURL, ...journeyArgs], { env: { ...process.env, PROBE_BASE_URL: boot.baseURL, PROBE_SERVER_PID: String(boot.server?.pid ?? ''), A19_TURN_MARKER: 'A19_SELFCHECK_TURN' } });
                    exitCode = child.code;
                    try { boot.server?.kill?.('SIGKILL'); } catch { /* gone */ }
                }
            } else {
                const child = await run(process.execPath, [path.join(here, 'run-against-pinned.mjs'), journeyPath, '--', ...journeyArgs], { env: { ...process.env, GOTAVERN_REFERENCE: reference, PINNED_READY_MS: process.env.PINNED_READY_MS ?? '600000' } });
                exitCode = child.code;
            }
            await peer.close().catch(() => {});
            let report = null;
            try { report = await readJson(reportPath); } catch { report = null; }
            handback[direction.name] = {
                source: path.relative(outDir, direction.source),
                exitCode, bootRefusal: refusal, elapsedMs: Date.now() - started,
                resumed: report?.layers?.lifecycle?.restart?.resumed ?? null,
                failedSteps: (report?.steps ?? []).filter(step => step.ok !== true).map(step => step.name),
                failure: report?.failure ?? refusal ?? (report === null ? 'the journey wrote no hand-back report' : null),
                providerWire: providerWireLayer(peer),
            };
            verdict.legs.push({ subject: direction.subject, phase: 'handback', exitCode, elapsedMs: handback[direction.name].elapsedMs, report: path.relative(outDir, reportPath), failure: handback[direction.name].failure });
        }
    }
    verdict.handback = handback;

    // ---- 6. THE JUDGE.
    const comparisonPath = path.join(outDir, 'a19-live-oracle-comparison.json');
    const comparisonRun = await run(process.execPath, [
        path.join(here, 'a19-compare-live-oracle.mjs'),
        '--legs-dir', path.join(outDir, 'legs'),
        '--corpus-tree-sha256', corpusCensus.treeSha256,
        '--corpus-origin', corpusOrigin,
        '--out', comparisonPath,
    ], { env: { ...process.env } });
    verdict.comparison = { exitCode: comparisonRun.code, path: comparisonPath };
    let comparison = null;
    try { comparison = await readJson(comparisonPath); } catch { comparison = null; }
    if (comparison) {
        // THE EVIDENCE-CONTRACT LAYER SHAPE: {ok, verdict, guards[]} per layer, straight from the judge.
        verdict.layers = comparison.layers;
        verdict.normalisations = comparison.normalisations ?? [];
        verdict.notCompared = comparison.notCompared ?? [];
        verdict.failedGuards = comparison.failedGuards ?? [];
        verdict.verdict = overallVerdict(comparison);
    } else {
        // A missing comparison is a HARNESS ERROR, not a pass. The five layers are still emitted so the
        // evidence verifier can name what is missing instead of failing on an undefined field.
        verdict.verdict = 'harness-error';
        verdict.failedGuards = ['comparison-missing'];
        verdict.layers = Object.fromEntries(['browser', 'http', 'providerWire', 'persistence', 'lifecycle'].map(layer => [layer, { ok: false, verdict: 'not-observed', guards: [] }]));
    }

    // ---- 7. THE TEETH, on THIS run's own artifacts (only meaningful on a green baseline).
    if (verdict.verdict === 'match') {
        const teethPath = path.join(outDir, 'a19-live-oracle-teeth.json');
        const teethRun = await run(process.execPath, [
            path.join(here, 'a19-oracle-teeth.mjs'),
            '--legs-dir', path.join(outDir, 'legs'),
            '--comparator', path.join(here, 'a19-compare-live-oracle.mjs'),
            '--corpus-tree-sha256', corpusCensus.treeSha256,
            '--corpus-origin', corpusOrigin,
            '--out', teethPath,
        ], { env: { ...process.env } });
        let teeth = null;
        try { teeth = await readJson(teethPath); } catch { teeth = null; }
        verdict.teeth = { exitCode: teethRun.code, path: teethPath, ok: teeth?.ok === true, killed: teeth?.killed ?? null, survived: teeth?.survived ?? null };
    }

    // ---- 8. THE IMMUTABLE INPUT DID NOT MOVE.
    verdict.corpusUnchanged = await assertOriginalUnchanged(fullCensus, corpusRoot);
    verdict.finishedAt = new Date().toISOString();
    const expectedPhases = skipPinned ? ['drive'] : phases;
    const legsDrove = Object.entries(legs).every(([key, leg]) => {
        const phase = key.split('-')[0];
        return !expectedPhases.includes(phase) || (leg.skipped !== true && leg.failure === null);
    });
    const plumbingGreen = legsDrove
        && verdict.corpusUnchanged.ok === true
        && verdict.verdict === 'match'
        && verdict.teeth?.ok === true;
    // ok:true is only ever written for RELEASE evidence; the self-check keeps its own truth but is not
    // admissible (releaseAdmissible:false and a distinct kind/file name above).
    verdict.ok = !selfCheck && plumbingGreen;
    verdict.plumbingGreen = plumbingGreen;

    const artifactName = selfCheck ? 'a19-self-check-verdict.json' : 'release-evidence.json';
    // A self-check MUST NOT leave a file that the release verifier could read as evidence: if an earlier
    // run left one behind, the self-check removes it rather than leaving a stale admissible document.
    if (selfCheck) await fs.rm(path.join(outDir, 'release-evidence.json'), { force: true }).catch(() => {});
    await writeJson(path.join(outDir, artifactName), verdict);
    console.error(`a19 live oracle (${selfCheck ? 'SELF-CHECK: synthetic stand-in, NOT the alpha.19 oracle' : 'real-UI oracle'}): ${plumbingGreen ? 'PLUMBING-GREEN' : 'FAIL'} ok=${verdict.ok} -> ${path.join(outDir, artifactName)}`);
    if (!plumbingGreen) console.error(JSON.stringify({ legsDrove, corpusUnchanged: verdict.corpusUnchanged, verdict: verdict.verdict, failedGuards: verdict.failedGuards, teeth: verdict.teeth }, null, 2));
    process.exit(verdict.ok ? 0 : 1);
}

main().catch(error => {
    console.error(`a19-live-oracle driver failed: ${error?.message ?? error}`);
    process.exit(1);
});
