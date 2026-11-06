#!/usr/bin/env node
// The darwin/arm64 release qualification: RECORDED PLATFORM LIMITATION, NOT EXECUTION.
//
// WHY THIS EXISTS. release.yml used to have one job, `execute-darwin-arm64` on `runs-on: macos-14`, that ran the
// built darwin/arm64 archive and polled its own /version. The publish job waited for that job, so a release could
// not be published with an unexecuted arm64 macOS archive. On 2026-11-05/06 the platform stopped provisioning that
// runner config: the job was cancelled after 54 s with ZERO steps, no assigned runner, and the check-run annotation
// `The configuration 'macos-14-arm64-us-default' is not supported`. The same job had executed successfully five
// times earlier on 2026-11-05 (runs 42018112346, 42035872824, 42051271771, 42061439366, 42085159949), so this is a
// platform-side unavailability of the arm64 macOS runner configuration, not a repository misconfiguration, and it
// cannot be fixed from this tree.
//
// THE OPTIONS THE PLAN ALLOWS ARE "resolve it or transparently downgrade it". Resolution would mean a genuinely
// available arm64 macOS runner; the only plausible alternative label is `macos-15` (the repository already uses
// `macos-15-intel` for x64), and choosing it would be an unverified guess that can only be tested by a dispatch, so
// it is documented as the restoration path rather than shipped as the gate. What IS shipped is the downgrade, and
// it is deliberately not a `continue-on-error` waiver:
//
//   * INSPECT mode runs on a runner that exists (ubuntu-latest). It proves the archive is a THIN ARM64 MACH-O
//     EXECUTABLE (magic 0xfeedfacf, cputype 0x0100000c), re-asserts the build+archive inspection contract the build
//     job asserts (members, BUILD-INFO version/target, the version string in the binary bytes, the tokenizer tree,
//     no shipped runtime state, tar executable bits), and writes a machine-readable marker carrying the archive
//     sha256, the Mach-O proof, the build-info target and the RECORDED platform evidence. It never claims execution.
//   * VERIFY mode is the publish gate. The publish job downloads the marker and runs it with the resolved curated
//     release notes and the archive it is about to publish. A missing marker, an unknown mode, a marker with no
//     arm64 Mach-O proof, an archive-sha mismatch, a marker that claims execution without execution evidence, or a
//     marker whose required release-notes limitation line is absent, all REFUSE publication by name -- and the
//     publish job runs `--self-test` first, so the refusal path itself is exercised on every release.
//   * The gate is REVERSIBLE and not a one-way door: a marker in `executed` mode is accepted when it carries real
//     execution evidence (uname says arm64/aarch64, `gotavern version` output, the pinned 1.19.0 /version record).
//     Restoring the real execution job means writing such a marker; the validator then requires execution evidence
//     instead of the note line. The decision record is docs/release-governance.md section 4.
//
// USAGE
//   node scripts/release-governance/darwin-arm64-qualification.mjs inspect \
//     --archive dist/gotavern-darwin-arm64.tar.gz --version v0.1.0-alpha.16 \
//     --out marker.json [--evidence-out inspection.txt]
//   node scripts/release-governance/darwin-arm64-qualification.mjs verify \
//     --marker marker.json --archive dist/gotavern-darwin-arm64.tar.gz \
//     --version v0.1.0-alpha.16 --notes docs/release-notes-v0.1.0-alpha.16.md
//   node scripts/release-governance/darwin-arm64-qualification.mjs --self-test
//
// Exit codes: 0 accepted, 1 refused (each refusal names its rail on stderr as `::error::`), 2 usage/inspection
// failure that is not a gate verdict.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const MARKER_SCHEMA_VERSION = 1;
export const MARKER_KIND = 'gotavern-darwin-arm64-platform-limitation';
export const TARGET = 'darwin/arm64';
export const ARCHIVE_NAME = 'gotavern-darwin-arm64.tar.gz';
export const MODE_RECORDED_DOWNGRADE = 'recorded-downgrade';
export const MODE_EXECUTED = 'executed';
export const REASON_CODE = 'platform-runner-unavailable';
export const RUNNER_LABEL_REQUESTED = 'macos-14';
export const MACHO_MAGIC = 0xfeedfacf; // MH_MAGIC_64 on disk as cf fa ed fe
export const MACHO_CPU_TYPE_ARM64 = 0x0100000c; // CPU_TYPE_ARM64 = 12 | CPU_ARCH_ABI64

// The release notes must carry a limitation line the publish gate can find. The exact wording is not prescribed,
// but both halves are: the target name and a qualification statement. The notes' Known limitations section uses
// this shape, and the gate refuses a note that dropped it (a downgrade that becomes invisible is a fake green).
export const REQUIRED_NOTES_PHRASES = [
    { name: 'target', regex: /darwin\/arm64/i, describe: 'the note names darwin/arm64' },
    {
        name: 'qualification',
        regex: /(NOT runtime-qualified|runtime execution is not qualified|NOT EXECUTED)/i,
        describe: 'the note states that darwin/arm64 runtime execution is NOT qualified',
    },
];

// THE RECORDED PLATFORM EVIDENCE. These are not invented: each row is readable from the Actions API, and the
// commands to re-read it are in docs/release-governance.md section 4. The `historicalSuccesses` rows are the
// evidence that the job and the archive are correct and that this is a platform-side unavailability, not a broken
// workflow: the SAME job on the SAME label executed five times earlier on 2026-11-05.
export const PLATFORM_EVIDENCE = {
    reasonCode: REASON_CODE,
    runnerLabelRequested: RUNNER_LABEL_REQUESTED,
    platformMessage: "The configuration 'macos-14-arm64-us-default' is not supported",
    attempts: [
        {
            workflow: 'GoTavern Release',
            runId: '42242191281',
            jobId: '127975851110',
            ref: 'a54db37',
            observedAt: '2026-11-06T15:22:23Z',
            cancelledAfterSeconds: 54,
            stepsExecuted: 0,
            runnerAssigned: false,
            conclusion: 'cancelled',
            annotation: "The configuration 'macos-14-arm64-us-default' is not supported",
        },
        {
            workflow: 'GoTavern Release',
            runId: '42113162581',
            jobId: '127552551348',
            ref: '95638da',
            observedAt: '2026-11-05T21:42:48Z',
            cancelledAfterSeconds: 0,
            stepsExecuted: 0,
            runnerAssigned: false,
            conclusion: 'cancelled',
            annotation: "The configuration 'macos-14-arm64-us-default' is not supported",
        },
    ],
    historicalSuccesses: [
        { runId: '42018112346', observedAt: '2026-11-05T11:24:12Z', conclusion: 'success' },
        { runId: '42035872824', observedAt: '2026-11-05T13:29:16Z', conclusion: 'success' },
        { runId: '42051271771', observedAt: '2026-11-05T15:08:53Z', conclusion: 'success' },
        { runId: '42061439366', observedAt: '2026-11-05T16:10:04Z', conclusion: 'success' },
        { runId: '42085159949', observedAt: '2026-11-05T18:35:10Z', conclusion: 'success' },
    ],
};

function refuse(message) {
    console.error(`::error::${message}`);
    process.exitCode = 1;
}

function usage(message) {
    console.error(`darwin-arm64-qualification.mjs: ${message}`);
    console.error('usage: inspect --archive <tar.gz> --version <v> --out <marker.json> [--evidence-out <txt>]');
    console.error('       verify --marker <marker.json> --archive <tar.gz> --notes <release-notes.md> [--version <v>]');
    console.error('       --self-test');
    process.exit(2);
}

function sha256File(filePath) {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function parseMachOHeader(buffer) {
    if (buffer.length < 12) throw new Error('the binary is shorter than a Mach-O header');
    const magic = buffer.readUInt32LE(0);
    if (magic !== MACHO_MAGIC) {
        throw new Error(
            `HEADER_MAGIC is 0x${magic.toString(16)} and not 0xfeedfacf (MH_MAGIC_64); the file is not a 64-bit little-endian Mach-O executable`,
        );
    }
    const cpuType = buffer.readUInt32LE(4);
    const subType = buffer.readUInt32LE(8);
    if (cpuType !== MACHO_CPU_TYPE_ARM64) {
        throw new Error(
            `Mach-O cputype is 0x${cpuType.toString(16)} and not 0x0100000c (CPU_TYPE_ARM64); the archive does not contain an arm64 executable`,
        );
    }
    return { magic: `0x${magic.toString(16).padStart(8, '0')}`, cpuType: `0x${cpuType.toString(16).padStart(8, '0')}`, cpuTypeName: 'arm64', subType: `0x${subType.toString(16).padStart(8, '0')}` };
}

function assertArchiveContract(staged) {
    const problems = [];
    const required = ['gotavern', 'start.sh', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'BUILD-INFO.txt'];
    for (const member of required) {
        try {
            const info = statSync(path.join(staged, member));
            if (!info.isFile()) problems.push(`${member} is not a file`);
            if (info.size === 0) problems.push(`${member} is empty`);
            // The executable-bit assertion is part of the tar contract and is enforced on the Linux runner. A
            // Windows checkout cannot represent Unix mode bits on disk (the same measured host artefact as the
            // CRLF/gofmt case), so a local Windows run records the limitation instead of manufacturing a red.
            if (process.platform === 'win32') continue;
            if (info.mode & 0o111) continue;
            if (member === 'gotavern' || member === 'start.sh') problems.push(`${member} is not executable in the tar archive`);
        } catch {
            problems.push(`${member} is missing`);
        }
    }
    const tokenizers = path.join(staged, 'src', 'tokenizers');
    try {
        const entries = readdirSync(tokenizers, { withFileTypes: true });
        const files = entries.filter((entry) => entry.isFile());
        if (files.length === 0) problems.push('src/tokenizers/ holds no files');
        const empties = files.filter((entry) => statSync(path.join(tokenizers, entry.name)).size === 0);
        if (empties.length > 0) problems.push(`src/tokenizers/ holds ${empties.length} empty file(s)`);
        const llama = path.join(tokenizers, 'llama.model');
        try {
            if (statSync(llama).size <= 100000) problems.push('src/tokenizers/llama.model is missing or implausibly small');
        } catch {
            problems.push('src/tokenizers/llama.model is missing');
        }
    } catch {
        problems.push('src/tokenizers/ is missing');
    }
    try {
        const duplicate = statSync(path.join(staged, 'tokenizers'));
        if (duplicate.isDirectory()) problems.push('carries a duplicate tokenizers/ tree at the archive root');
    } catch {
        // absent is the contract
    }
    for (const forbidden of ['config.yaml', 'data', 'extensions', 'certs', '_storage', 'cookie-secret.txt', 'secrets.json']) {
        try {
            statSync(path.join(staged, forbidden));
            problems.push(`the archive carries ${forbidden}, which must never ship`);
        } catch {
            // absent is the contract
        }
    }
    return problems;
}

function inspect({ archive, version, out, evidenceOut }) {
    if (!archive || !version || !out) usage('inspect requires --archive, --version and --out');
    const archiveSha256 = sha256File(archive);
    const archiveSizeBytes = statSync(archive).size;
    const work = mkdtempSync(path.join(tmpdir(), 'darwin-arm64-inspection-'));
    const evidence = [];
    try {
        try {
            execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: 'inherit' });
        } catch (error) {
            refuse(`archive-extract-failed: ${archive} is not a readable tar.gz (${error.message})`);
            return 2;
        }
        const contractProblems = assertArchiveContract(work);
        if (contractProblems.length > 0) {
            for (const problem of contractProblems) console.error(`::error::archive-contract: ${problem}`);
            return 1;
        }
        evidence.push('archive-contract: members, executable bits, tokenizers tree, no shipped runtime state: OK');
        const buildInfo = readFileSync(path.join(work, 'BUILD-INFO.txt'), 'utf8');
        if (!buildInfo.includes(`GoTavern release ${version}`)) {
            refuse(`build-info-version: BUILD-INFO.txt does not name the release version '${version}': ${JSON.stringify(buildInfo)}`);
            return 1;
        }
        if (!/^target darwin$/m.test(buildInfo)) {
            refuse(`build-info-target: BUILD-INFO.txt does not declare 'target darwin': ${JSON.stringify(buildInfo)}`);
            return 1;
        }
        evidence.push(`build-info: names ${version} and target darwin: OK`);
        const binary = readFileSync(path.join(work, 'gotavern'));
        if (!binary.includes(Buffer.from(version, 'utf8'))) {
            refuse(`binary-version-string: the binary does not carry the release version string '${version}'; -X main.version was not applied`);
            return 1;
        }
        evidence.push(`binary-version-string: the shipped binary carries '${version}': OK`);
        let machO;
        try {
            machO = parseMachOHeader(binary);
        } catch (error) {
            refuse(`mach-o-not-arm64: ${error.message}`);
            return 1;
        }
        evidence.push(`mach-o: magic ${machO.magic}, cputype ${machO.cpuType} (arm64): OK`);
        const marker = {
            schemaVersion: MARKER_SCHEMA_VERSION,
            kind: MARKER_KIND,
            target: TARGET,
            version,
            archive: ARCHIVE_NAME,
            archiveSha256,
            archiveSizeBytes,
            mode: MODE_RECORDED_DOWNGRADE,
            reasonCode: PLATFORM_EVIDENCE.reasonCode,
            runnerLabelRequested: PLATFORM_EVIDENCE.runnerLabelRequested,
            platformEvidence: PLATFORM_EVIDENCE,
            inspection: {
                machO,
                buildInfo: { goos: 'darwin', goarch: 'arm64', releaseLine: `GoTavern release ${version}`, targetLine: 'target darwin' },
                members: ['gotavern', 'start.sh', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'BUILD-INFO.txt', 'src/tokenizers/'],
            },
            execution: { performed: false, evidence: null },
            requiredReleaseNotes: {
                phrases: REQUIRED_NOTES_PHRASES.map((phrase) => phrase.describe),
                source: 'docs/release-governance.md section 4',
            },
            recordedAt: new Date().toISOString(),
        };
        writeFileSync(out, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
        evidence.push(`marker: wrote ${out} (mode ${MODE_RECORDED_DOWNGRADE}, archive sha256 ${archiveSha256})`);
        if (evidenceOut) writeFileSync(evidenceOut, `${evidence.join('\n')}\n`, 'utf8');
        console.log(`ok: ${archive} is a THIN ARM64 MACH-O executable and satisfies the build+archive inspection contract`);
        console.log('    execution: NOT PERFORMED; the platform limitation is recorded in the marker, not waived');
        console.log(`wrote ${out}`);
        return 0;
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

// The pure gate. Everything the publish job decides is here, so the planted cases exercise the same code path as
// the real marker. `archiveSha256` is the digest the publish job computed from the archive it is about to upload.
export function evaluateMarker({ markerText, notesText, archiveSha256, expectedVersion = null }) {
    const problems = [];
    const observations = [];
    if (typeof markerText !== 'string' || markerText.trim() === '') {
        problems.push(
            'missing-marker: no darwin/arm64 platform-limitation marker was supplied; the publish gate refuses to publish an arm64 macOS archive whose execution is neither proven nor recorded as a platform limitation',
        );
        return { ok: false, problems, observations };
    }
    let marker;
    try {
        marker = JSON.parse(markerText);
    } catch (error) {
        problems.push(`marker-invalid: the darwin/arm64 platform-limitation marker is not valid JSON (${error.message})`);
        return { ok: false, problems, observations };
    }
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) {
        problems.push('marker-invalid: the darwin/arm64 platform-limitation marker is not a JSON object');
        return { ok: false, problems, observations };
    }
    if (marker.schemaVersion !== MARKER_SCHEMA_VERSION) {
        problems.push(`marker-schema: marker schemaVersion is ${JSON.stringify(marker.schemaVersion)} and not ${MARKER_SCHEMA_VERSION}`);
    }
    if (marker.kind !== MARKER_KIND) {
        problems.push(`marker-kind: marker kind is ${JSON.stringify(marker.kind)} and not ${JSON.stringify(MARKER_KIND)}`);
    }
    if (marker.target !== TARGET) {
        problems.push(`marker-target: marker target is ${JSON.stringify(marker.target)} and not ${JSON.stringify(TARGET)}`);
    }
    if (marker.archive !== ARCHIVE_NAME) {
        problems.push(`marker-archive: marker archive is ${JSON.stringify(marker.archive)} and not ${JSON.stringify(ARCHIVE_NAME)}`);
    }
    if (typeof marker.version !== 'string' || marker.version === '') {
        problems.push('marker-version: marker carries no release version');
    } else if (expectedVersion !== null && marker.version !== expectedVersion) {
        problems.push(`marker-version: marker names release ${JSON.stringify(marker.version)} but this publish is ${JSON.stringify(expectedVersion)}`);
    }
    if (marker.archiveSha256 !== archiveSha256) {
        problems.push(
            `archive-sha-mismatch: marker archiveSha256 is ${JSON.stringify(marker.archiveSha256)} but the archive being published is ${archiveSha256}`,
        );
    }
    if (marker.mode === MODE_RECORDED_DOWNGRADE) {
        if (marker.reasonCode !== REASON_CODE) {
            problems.push(
                `reason-code-unknown: recorded-downgrade marker reasonCode is ${JSON.stringify(marker.reasonCode)} and not ${JSON.stringify(REASON_CODE)}; an unexplained downgrade is refused`,
            );
        }
        const machO = marker.inspection && marker.inspection.machO;
        if (!machO || machO.cpuType !== '0x0100000c' || machO.cpuTypeName !== 'arm64') {
            problems.push(
                `mach-o-not-arm64: the marker does not prove the archive's Mach-O CPU type is arm64 (inspection.machO=${JSON.stringify(machO)})`,
            );
        }
        const buildInfo = marker.inspection && marker.inspection.buildInfo;
        if (!buildInfo || buildInfo.goos !== 'darwin' || buildInfo.goarch !== 'arm64') {
            problems.push(
                `build-info-target-mismatch: the marker does not declare the archive's build-info target darwin/arm64 (inspection.buildInfo=${JSON.stringify(buildInfo)})`,
            );
        }
        const attempts = marker.platformEvidence && marker.platformEvidence.attempts;
        if (!Array.isArray(attempts) || attempts.length === 0) {
            problems.push('platform-evidence-missing: the marker records no platform attempts (a downgrade with no recorded platform failure is an unexplained gap)');
        } else {
            for (const [index, attempt] of attempts.entries()) {
                if (!attempt || !/^\d{8,12}$/.test(String(attempt.runId))) {
                    problems.push(`platform-evidence-missing: platformEvidence.attempts[${index}] carries no real run id`);
                }
                if (!attempt || !/^\d{8,}$/.test(String(attempt.jobId))) {
                    problems.push(`platform-evidence-missing: platformEvidence.attempts[${index}] carries no real job id`);
                }
                if (!attempt || typeof attempt.annotation !== 'string' || attempt.annotation.trim() === '') {
                    problems.push(`platform-evidence-missing: platformEvidence.attempts[${index}] carries no platform annotation`);
                }
                if (!attempt || !['cancelled', 'failure'].includes(attempt.conclusion)) {
                    problems.push(`platform-evidence-missing: platformEvidence.attempts[${index}] conclusion is ${JSON.stringify(attempt && attempt.conclusion)}`);
                }
            }
        }
        if (!marker.execution || marker.execution.performed !== false) {
            problems.push('execution-claim-without-evidence: a recorded-downgrade marker must record execution.performed=false');
        }
        const notes = typeof notesText === 'string' ? notesText : '';
        const missingPhrases = REQUIRED_NOTES_PHRASES.filter((phrase) => !phrase.regex.test(notes));
        if (missingPhrases.length > 0) {
            problems.push(
                `notes-limitation-missing: the curated release notes do not carry the recorded-downgrade limitation line; missing: ${missingPhrases
                    .map((phrase) => phrase.describe)
                    .join('; ')} (a downgrade that is not stated in the published notes is a hidden gap)`,
            );
        }
        observations.push(`recorded-downgrade marker: ${attempts ? attempts.length : 0} platform attempt(s), Mach-O arm64 proven, archive sha256 matched`);
    } else if (marker.mode === MODE_EXECUTED) {
        const execution = marker.execution;
        const evidence = execution && execution.evidence;
        if (!execution || execution.performed !== true || !evidence) {
            problems.push('execution-evidence-missing: an executed marker must carry execution.performed=true and an execution evidence document');
        } else {
            if (!/arm64|aarch64/i.test(String(evidence.unameMachine))) {
                problems.push(`execution-evidence-missing: execution evidence unameMachine is ${JSON.stringify(evidence.unameMachine)} and does not say arm64/aarch64`);
            }
            if (evidence.pkgVersion !== '1.19.0') {
                problems.push(`execution-evidence-missing: execution evidence /version pkgVersion is ${JSON.stringify(evidence.pkgVersion)} and not "1.19.0"`);
            }
            if (typeof evidence.versionOutput !== 'string' || evidence.versionOutput.trim() === '') {
                problems.push('execution-evidence-missing: execution evidence carries no `gotavern version` output');
            }
        }
        observations.push('executed marker: real execution evidence supplied, release-notes limitation line not required');
    } else {
        problems.push(
            `unknown-mode: marker mode is ${JSON.stringify(marker.mode)}; known modes are ${JSON.stringify(MODE_RECORDED_DOWNGRADE)} and ${JSON.stringify(MODE_EXECUTED)}`,
        );
    }
    return { ok: problems.length === 0, problems, observations };
}

function verify({ marker: markerPath, archive, notes, version }) {
    if (!markerPath || !archive) usage('verify requires --marker and --archive (--notes is required for a recorded downgrade)');
    let markerText;
    try {
        markerText = readFileSync(markerPath, 'utf8');
    } catch (error) {
        refuse(`missing-marker: cannot read the darwin/arm64 platform-limitation marker at ${markerPath} (${error.message})`);
        return 1;
    }
    let notesText = '';
    if (typeof notes === 'string' && notes.trim() !== '') {
        try {
            notesText = readFileSync(notes, 'utf8');
        } catch (error) {
            refuse(`notes-limitation-missing: cannot read the curated release notes at ${notes} (${error.message}); a recorded downgrade requires the limitation line to be published, so absent notes are refused`);
            return 1;
        }
    }
    const archiveSha256 = sha256File(archive);
    const verdict = evaluateMarker({ markerText, notesText, archiveSha256, expectedVersion: version || null });
    for (const observation of verdict.observations) console.log(`  note: ${observation}`);
    if (!verdict.ok) {
        for (const problem of verdict.problems) console.error(`::error::${problem}`);
        process.exitCode = 1;
        return 1;
    }
    console.log(`ok: the darwin/arm64 ${JSON.parse(markerText).mode} marker satisfies the publish gate (archive sha256 ${archiveSha256})`);
    return 0;
}

// THE PLANTED CASES. The publish job runs this before the real marker, so the refusal path cannot rot into a step
// that only ever sees a good input. Each case is named, and a case that does not hold fails this program.
export function selfTest() {
    const digest = createHash('sha256').update('self-test-archive').digest('hex');
    const notesWithLine = 'Known limitations\n\nThe darwin/arm64 archive is NOT runtime-qualified and was not executed.\n';
    const notesWithoutLine = 'Known limitations\n\nEverything is fine.\n';
    const baseMarker = {
        schemaVersion: MARKER_SCHEMA_VERSION,
        kind: MARKER_KIND,
        target: TARGET,
        version: 'v0.1.0-alpha.16',
        archive: ARCHIVE_NAME,
        archiveSha256: digest,
        mode: MODE_RECORDED_DOWNGRADE,
        reasonCode: REASON_CODE,
        inspection: {
            machO: { magic: '0xfeedfacf', cpuType: '0x0100000c', cpuTypeName: 'arm64' },
            buildInfo: { goos: 'darwin', goarch: 'arm64' },
        },
        platformEvidence: {
            attempts: [
                {
                    runId: '42242191281',
                    jobId: '127975851110',
                    conclusion: 'cancelled',
                    annotation: "The configuration 'macos-14-arm64-us-default' is not supported",
                },
            ],
        },
        execution: { performed: false, evidence: null },
    };
    const clone = (overrides) => JSON.stringify({ ...baseMarker, ...overrides });
    const cases = [
        {
            name: 'missing-marker-refused',
            input: { markerText: '', notesText: notesWithLine, archiveSha256: digest },
            expect: 'missing-marker',
        },
        {
            name: 'invalid-json-refused',
            input: { markerText: '{not json', notesText: notesWithLine, archiveSha256: digest },
            expect: 'marker-invalid',
        },
        {
            name: 'unknown-mode-refused',
            input: { markerText: clone({ mode: 'waived' }), notesText: notesWithLine, archiveSha256: digest },
            expect: 'unknown-mode',
        },
        {
            name: 'downgrade-without-notes-line-refused',
            input: { markerText: clone({}), notesText: notesWithoutLine, archiveSha256: digest },
            expect: 'notes-limitation-missing',
        },
        {
            name: 'downgrade-without-macho-proof-refused',
            input: { markerText: clone({ inspection: { machO: { cpuType: '0x01000007', cpuTypeName: 'x86_64' }, buildInfo: { goos: 'darwin', goarch: 'amd64' } } }), notesText: notesWithLine, archiveSha256: digest },
            expect: 'mach-o-not-arm64',
        },
        {
            name: 'downgrade-without-platform-evidence-refused',
            input: { markerText: clone({ platformEvidence: { attempts: [] } }), notesText: notesWithLine, archiveSha256: digest },
            expect: 'platform-evidence-missing',
        },
        {
            name: 'downgrade-claiming-execution-refused',
            input: { markerText: clone({ execution: { performed: true, evidence: { unameMachine: 'arm64' } } }), notesText: notesWithLine, archiveSha256: digest },
            expect: 'execution-claim-without-evidence',
        },
        {
            name: 'archive-sha-mismatch-refused',
            input: { markerText: clone({}), notesText: notesWithLine, archiveSha256: 'f'.repeat(64) },
            expect: 'archive-sha-mismatch',
        },
        {
            name: 'executed-marker-without-evidence-refused',
            input: { markerText: clone({ mode: MODE_EXECUTED, execution: { performed: true, evidence: null } }), notesText: notesWithoutLine, archiveSha256: digest },
            expect: 'execution-evidence-missing',
        },
        {
            name: 'valid-recorded-downgrade-accepted',
            input: { markerText: clone({}), notesText: notesWithLine, archiveSha256: digest },
            expect: null,
        },
        {
            name: 'valid-executed-marker-accepted',
            input: {
                markerText: clone({
                    mode: MODE_EXECUTED,
                    execution: {
                        performed: true,
                        evidence: { unameMachine: 'arm64', pkgVersion: '1.19.0', versionOutput: 'GoTavern v0.1.0-alpha.16\n' },
                    },
                }),
                notesText: notesWithoutLine,
                archiveSha256: digest,
            },
            expect: null,
        },
    ];
    let failed = 0;
    for (const testCase of cases) {
        const verdict = evaluateMarker(testCase.input);
        const holds = testCase.expect === null ? verdict.ok : !verdict.ok && verdict.problems.some((problem) => problem.includes(testCase.expect));
        if (holds) {
            console.log(`ok [${testCase.name}]`);
        } else {
            failed += 1;
            console.error(`FAIL [${testCase.name}]: expected ${testCase.expect === null ? 'acceptance' : `refusal naming "${testCase.expect}"`}, got ok=${verdict.ok} problems=${JSON.stringify(verdict.problems)}`);
        }
    }
    if (failed > 0) {
        console.error(`FAIL: ${failed} of ${cases.length} darwin/arm64 platform-limitation planted cases did not hold`);
        return 1;
    }
    console.log(`darwin/arm64 platform-limitation planted cases hold: ${cases.length}/${cases.length}`);
    return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const [command, ...rest] = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) continue;
        options[token.slice(2)] = rest[index + 1];
        index += 1;
    }
    if (command === '--self-test') {
        process.exitCode = selfTest();
    } else if (command === 'inspect') {
        process.exitCode = inspect({ archive: options.archive, version: options.version, out: options.out, evidenceOut: options['evidence-out'] });
    } else if (command === 'verify') {
        process.exitCode = verify({ marker: options.marker, archive: options.archive, notes: options.notes, version: options.version });
    } else if (command === undefined) {
        usage('a command is required');
    } else {
        usage(`unknown command ${JSON.stringify(command)}`);
    }
}
