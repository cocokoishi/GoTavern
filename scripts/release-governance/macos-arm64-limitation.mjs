#!/usr/bin/env node
// The macOS-arm64 platform limitation for the THIRD-PARTY EXTENSION COMPATIBILITY gate.
//
// WHY THIS EXISTS. The gate's cross-platform job used to have three legs: windows-amd64, macos-amd64 and
// macos-arm64 (the last on `runs-on: macos-14`). The arm64 leg is the same platform-side failure diagnosed for
// GoTavern Release (docs/release-governance.md section 4): the runner is never assigned, the job is cancelled
// with zero steps, and the check-run annotation says
// `The configuration 'macos-14-arm64-us-default' is not supported`. Because a cancelled job makes the workflow
// conclusion `cancelled`, the release manifest's gate #11 cannot be green. The same leg ran successfully four
// times on 2026-11-05 (runs 42035843369, 42051239530, 42061390096, 42085125376) and has been refused since
// 2026-11-05T21:42Z (three re-dispatches: 42237701919, 42242177874, 42247719306), so this is platform-side
// unavailability, not a repository misconfiguration.
//
// THE DECISION IS THE SAME PATTERN AS THE RELEASE ARCHIVE: a TRANSPARENT RECORDED LIMITATION, never a
// continue-on-error. The arm64 matrix leg is REMOVED; a small `macos-arm64-recorded-limitation` job on a runner
// that exists (ubuntu-24.04) asserts that the matrix no longer claims the arm64 leg and writes a
// machine-readable marker plus human-readable evidence. The aggregate job REQUIRES that marker, refuses when it
// is absent, and copies it into the `extension-compat-evidence` artifact, so the release gate's evidence carries
// the disclosure instead of hiding the missing leg. The two remaining legs (windows-amd64, macos-amd64) are the
// cross-platform evidence that still exists; macOS arm64 extension lifecycle remains UNPROVEN.
//
// USAGE
//   node scripts/release-governance/macos-arm64-limitation.mjs record \
//     --workflow .github/workflows/third-party-extension-compat.yml \
//     --out marker.json [--evidence-out evidence.txt]
//   node scripts/release-governance/macos-arm64-limitation.mjs verify \
//     --marker marker.json --workflow .github/workflows/third-party-extension-compat.yml \
//     [--evidence-out extension-compat-evidence/macos-arm64-platform-limitation.json]
//   node scripts/release-governance/macos-arm64-limitation.mjs --self-test
//
// Exit codes: 0 accepted, 1 refused (named `::error::`), 2 usage/parse failure that is not a gate verdict.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const MARKER_SCHEMA_VERSION = 1;
export const MARKER_KIND = 'gotavern-macos-arm64-platform-limitation';
export const WORKFLOW_NAME = 'Third-party extension compatibility';
export const TARGET = 'macos/arm64';
export const MODE_RECORDED_LIMITATION = 'recorded-limitation';
export const REASON_CODE = 'platform-runner-unavailable';
export const RUNNER_LABEL_REQUESTED = 'macos-14';
export const LIMITATION_JOB = 'macos-arm64-recorded-limitation';
export const RECORDED_SCRIPT = 'scripts/release-governance/macos-arm64-limitation.mjs';
export const REQUIRED_CROSS_PLATFORM_LEGS = ['windows-amd64', 'macos-amd64'];
export const REMOVED_LEG = 'macos-arm64';

// THE RECORDED EVIDENCE, readable from the Actions API (commands in docs/release-governance.md section 4).
// `attempts` are the three re-dispatches whose ONLY failing job was this arm64 leg; `historicalSuccesses` are
// the same leg's green runs on 2026-11-05, which is what makes this a platform regression rather than a
// workflow defect. Do not add an attempt without reading its annotation from the API first.
export const RECORDED_EVIDENCE = {
    reasonCode: REASON_CODE,
    runnerLabelRequested: RUNNER_LABEL_REQUESTED,
    platformMessage: "The configuration 'macos-14-arm64-us-default' is not supported",
    attempts: [
        {
            workflow: WORKFLOW_NAME,
            runId: '42247719306',
            jobId: '127994821648',
            ref: 'b548687',
            observedAt: '2026-11-06T15:57:46Z',
            cancelledAfterSeconds: 9,
            stepsExecuted: 0,
            runnerAssigned: false,
            conclusion: 'cancelled',
            annotation: "The configuration 'macos-14-arm64-us-default' is not supported",
        },
        {
            workflow: WORKFLOW_NAME,
            runId: '42242177874',
            jobId: '127975802797',
            ref: 'a54db37',
            observedAt: '2026-11-06T15:22:18Z',
            cancelledAfterSeconds: 35,
            stepsExecuted: 0,
            runnerAssigned: false,
            conclusion: 'cancelled',
            annotation: "The configuration 'macos-14-arm64-us-default' is not supported",
        },
        {
            workflow: WORKFLOW_NAME,
            runId: '42237701919',
            jobId: '127959956023',
            ref: '9f6a76e',
            observedAt: '2026-11-06T14:52:30Z',
            cancelledAfterSeconds: 17,
            stepsExecuted: 0,
            runnerAssigned: false,
            conclusion: 'cancelled',
            annotation: "The configuration 'macos-14-arm64-us-default' is not supported",
        },
    ],
    historicalSuccesses: [
        { workflow: WORKFLOW_NAME, runId: '42035843369', observedAt: '2026-11-05T13:26:56Z', conclusion: 'success' },
        { workflow: WORKFLOW_NAME, runId: '42051239530', observedAt: '2026-11-05T15:04:30Z', conclusion: 'success' },
        { workflow: WORKFLOW_NAME, runId: '42061390096', observedAt: '2026-11-05T16:06:52Z', conclusion: 'success' },
        { workflow: WORKFLOW_NAME, runId: '42085125376', observedAt: '2026-11-05T18:31:55Z', conclusion: 'success' },
    ],
};

function refuse(message) {
    console.error(`::error::${message}`);
    process.exitCode = 1;
}

function usage(message) {
    console.error(`macos-arm64-limitation.mjs: ${message}`);
    console.error('usage: record --workflow <path> --out <marker.json> [--evidence-out <txt>]');
    console.error('       verify --marker <marker.json> --workflow <path> [--evidence-out <json>]');
    console.error('       --self-test');
    process.exit(2);
}

function sha256Text(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function jobBlock(workflowText, jobName) {
    const lines = workflowText.split(/\r?\n/);
    const header = new RegExp(`^  ${jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`);
    const start = lines.findIndex((line) => header.test(line));
    if (start === -1) return null;
    const nextJob = /^  [a-z0-9-]+:\s*$/;
    const block = [];
    for (let index = start + 1; index < lines.length; index += 1) {
        if (nextJob.test(lines[index])) break;
        block.push(lines[index]);
    }
    return block.join('\n');
}

// A small surface parser, not a YAML library: the workflow is the evidence, and the two facts the gate needs
// are the platforms in the cross-platform matrix and whether a recorded-limitation job exists. Everything is
// line-oriented and the caller gets a named refusal when a shape is missing instead of a silent [].
export function parseCrossPlatform(workflowText) {
    const block = jobBlock(workflowText, 'cross-platform');
    if (block === null) {
        return { ok: false, problems: ['cross-platform-job-missing: the workflow has no `cross-platform:` job'] };
    }
    const platforms = [...block.matchAll(/^\s+platform:\s*([A-Za-z0-9._/-]+)\s*$/gm)].map((match) => match[1]);
    const osValues = [...block.matchAll(/^\s+os:\s*([A-Za-z0-9._/-]+)\s*$/gm)].map((match) => match[1]);
    const hasArm64Leg = platforms.includes('macos-arm64') || osValues.includes('macos-14');
    return {
        ok: true,
        problems: [],
        platforms,
        osValues,
        hasArm64Leg,
        hasLimitationJob: new RegExp(`^  ${LIMITATION_JOB}:\\s*$`, 'm').test(workflowText),
        hasRecordStep: /macos-arm64-limitation\.mjs\s+record/.test(workflowText),
    };
}

export function buildMarker({ workflowText }) {
    const matrix = parseCrossPlatform(workflowText);
    const marker = {
        schemaVersion: MARKER_SCHEMA_VERSION,
        kind: MARKER_KIND,
        workflow: WORKFLOW_NAME,
        scope: 'cross-platform representative extension lifecycle (two extensions per leg)',
        target: TARGET,
        mode: MODE_RECORDED_LIMITATION,
        reasonCode: RECORDED_EVIDENCE.reasonCode,
        runnerLabelRequested: RECORDED_EVIDENCE.runnerLabelRequested,
        matrix: {
            crossPlatformPresent: matrix.platforms.filter((platform) => REQUIRED_CROSS_PLATFORM_LEGS.includes(platform)),
            removed: [REMOVED_LEG],
            arm64LegPresent: matrix.hasArm64Leg,
            workflowSha256: sha256Text(workflowText),
        },
        platformEvidence: RECORDED_EVIDENCE,
        execution: { performed: false, evidence: null },
        coveredBy:
            'windows-amd64 and macos-amd64 run the same representative lifecycle differential; macos/arm64 is NOT run on this platform and its extension lifecycle is UNPROVEN',
        requiredEvidence: {
            artifact: 'extension-compat-evidence',
            carriedBy: 'the aggregate job copies this marker into the extension-compat-evidence artifact before upload',
        },
        recordedAt: new Date().toISOString(),
    };
    return { marker, matrix };
}

export function evaluateLimitation({ markerText, workflowText = null }) {
    const problems = [];
    const observations = [];
    if (typeof markerText !== 'string' || markerText.trim() === '') {
        problems.push(
            'missing-marker: the aggregate/release evidence carries no macos/arm64 platform-limitation marker; the gate refuses to accept cross-platform evidence whose missing arm64 leg is not recorded',
        );
        return { ok: false, problems, observations };
    }
    let marker;
    try {
        marker = JSON.parse(markerText);
    } catch (error) {
        problems.push(`marker-invalid: the macos/arm64 limitation marker is not valid JSON (${error.message})`);
        return { ok: false, problems, observations };
    }
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) {
        problems.push('marker-invalid: the macos/arm64 limitation marker is not a JSON object');
        return { ok: false, problems, observations };
    }
    if (marker.schemaVersion !== MARKER_SCHEMA_VERSION) {
        problems.push(`marker-schema: marker schemaVersion is ${JSON.stringify(marker.schemaVersion)} and not ${MARKER_SCHEMA_VERSION}`);
    }
    if (marker.kind !== MARKER_KIND) {
        problems.push(`marker-kind: marker kind is ${JSON.stringify(marker.kind)} and not ${JSON.stringify(MARKER_KIND)}`);
    }
    if (marker.workflow !== WORKFLOW_NAME) {
        problems.push(`marker-workflow: marker workflow is ${JSON.stringify(marker.workflow)} and not ${JSON.stringify(WORKFLOW_NAME)}`);
    }
    if (marker.target !== TARGET) {
        problems.push(`marker-target: marker target is ${JSON.stringify(marker.target)} and not ${JSON.stringify(TARGET)}`);
    }
    if (marker.mode !== MODE_RECORDED_LIMITATION) {
        problems.push(
            `unknown-mode: marker mode is ${JSON.stringify(marker.mode)}; this workflow's only known mode is ${JSON.stringify(MODE_RECORDED_LIMITATION)}`,
        );
    }
    if (marker.reasonCode !== REASON_CODE) {
        problems.push(`reason-code-unknown: marker reasonCode is ${JSON.stringify(marker.reasonCode)} and not ${JSON.stringify(REASON_CODE)}`);
    }
    const matrix = marker.matrix;
    if (!matrix || matrix.arm64LegPresent !== false) {
        problems.push(
            `arm64-leg-still-claimed: the marker does not record matrix.arm64LegPresent=false (matrix=${JSON.stringify(matrix)}); a removed leg that the record still claims is a refused state`,
        );
    }
    const present = Array.isArray(matrix && matrix.crossPlatformPresent) ? matrix.crossPlatformPresent : [];
    for (const leg of REQUIRED_CROSS_PLATFORM_LEGS) {
        if (!present.includes(leg)) {
            problems.push(`cross-platform-legs-missing: the marker does not record the ${leg} leg, which must still run`);
        }
    }
    const attempts = marker.platformEvidence && marker.platformEvidence.attempts;
    if (!Array.isArray(attempts) || attempts.length === 0) {
        problems.push('platform-evidence-missing: the marker records no platform attempt (a removed leg with no recorded platform refusal is an unexplained gap)');
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
        problems.push('execution-claim-without-evidence: a recorded-limitation marker must record execution.performed=false');
    }
    if (typeof workflowText === 'string' && workflowText.trim() !== '') {
        const parsed = parseCrossPlatform(workflowText);
        if (!parsed.ok) {
            problems.push(parsed.problems[0]);
        } else {
            if (parsed.hasArm64Leg) {
                problems.push(
                    'workflow-still-has-arm64-leg: the workflow still declares an os: macos-14 / platform: macos-arm64 cross-platform leg, so the limitation record does not match the workflow',
                );
            }
            if (!parsed.hasLimitationJob) {
                problems.push(`limitation-job-missing: the workflow has no ${LIMITATION_JOB} job`);
            }
            if (!parsed.hasRecordStep) {
                problems.push('limitation-record-missing: the workflow does not run the limitation record step');
            }
        }
    }
    if (problems.length === 0) {
        observations.push(
            `recorded-limitation marker: ${attempts.length} platform attempt(s), cross-platform legs ${present.join(' + ')}, macos-arm64 recorded as removed`,
        );
    }
    return { ok: problems.length === 0, problems, observations };
}

function record({ workflow, out, evidenceOut }) {
    if (!workflow || !out) usage('record requires --workflow and --out');
    let workflowText;
    try {
        workflowText = readFileSync(workflow, 'utf8');
    } catch (error) {
        refuse(`workflow-unreadable: cannot read ${workflow} (${error.message})`);
        return 2;
    }
    const parsed = parseCrossPlatform(workflowText);
    if (!parsed.ok) {
        refuse(parsed.problems[0]);
        return 1;
    }
    if (parsed.hasArm64Leg) {
        refuse('workflow-still-has-arm64-leg: the cross-platform matrix still declares os: macos-14 / platform: macos-arm64; refusing to record a limitation for a leg that is still claimed');
        return 1;
    }
    for (const leg of REQUIRED_CROSS_PLATFORM_LEGS) {
        if (!parsed.platforms.includes(leg)) {
            refuse(`cross-platform-legs-missing: the cross-platform matrix no longer declares ${leg}; the remaining cross-platform evidence must still run`);
            return 1;
        }
    }
    if (!parsed.hasLimitationJob || !parsed.hasRecordStep) {
        refuse('limitation-record-missing: the recorded-limitation job or its record step is missing from the workflow');
        return 1;
    }
    const { marker } = buildMarker({ workflowText });
    writeFileSync(out, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    const evidence = [
        `workflow: ${WORKFLOW_NAME}`,
        `matrix present: ${parsed.platforms.join(', ')}`,
        `removed leg: ${REMOVED_LEG} (recorded platform limitation)`,
        `platform evidence: ${RECORDED_EVIDENCE.attempts.length} cancelled attempts, ${RECORDED_EVIDENCE.historicalSuccesses.length} historical successes`,
        `marker: ${out}`,
        `execution: NOT PERFORMED on macos/arm64; extension lifecycle there is UNPROVEN`,
    ];
    if (evidenceOut) writeFileSync(evidenceOut, `${evidence.join('\n')}\n`, 'utf8');
    console.log(`ok: recorded macos/arm64 platform limitation (cross-platform legs: ${parsed.platforms.join(', ')})`);
    console.log(`wrote ${out}`);
    return 0;
}

function verify({ marker, workflow, evidenceOut }) {
    if (!marker || !workflow) usage('verify requires --marker and --workflow');
    let markerText;
    try {
        markerText = readFileSync(marker, 'utf8');
    } catch (error) {
        refuse(`missing-marker: cannot read the macos/arm64 limitation marker at ${marker} (${error.message})`);
        return 1;
    }
    let workflowText = '';
    try {
        workflowText = readFileSync(workflow, 'utf8');
    } catch (error) {
        refuse(`workflow-unreadable: cannot read ${workflow} (${error.message})`);
        return 1;
    }
    const verdict = evaluateLimitation({ markerText, workflowText });
    for (const observation of verdict.observations) console.log(`  note: ${observation}`);
    if (!verdict.ok) {
        for (const problem of verdict.problems) console.error(`::error::${problem}`);
        process.exitCode = 1;
        return 1;
    }
    if (evidenceOut) {
        const published = {
            schemaVersion: 1,
            kind: 'gotavern-macos-arm64-limitation-check',
            checkedAt: new Date().toISOString(),
            workflowSha256: sha256Text(workflowText),
            marker: JSON.parse(markerText),
            verdict: { ok: true, observations: verdict.observations },
        };
        writeFileSync(evidenceOut, `${JSON.stringify(published, null, 2)}\n`, 'utf8');
        console.log(`wrote the published limitation record to ${evidenceOut}`);
    }
    console.log('ok: the macos/arm64 recorded limitation satisfies the cross-platform evidence gate');
    return 0;
}

export function selfTest() {
    const validWorkflow = [
        'jobs:',
        '  cross-platform:',
        '    strategy:',
        '      matrix:',
        '        include:',
        '          - os: windows-latest',
        '            platform: windows-amd64',
        '          - os: macos-15-intel',
        '            platform: macos-amd64',
        '  macos-arm64-recorded-limitation:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - run: node scripts/release-governance/macos-arm64-limitation.mjs record --workflow x --out y',
        '',
    ].join('\n');
    const arm64Workflow = validWorkflow.replace(
        '          - os: macos-15-intel\n            platform: macos-amd64',
        '          - os: macos-15-intel\n            platform: macos-amd64\n          - os: macos-14\n            platform: macos-arm64',
    );
    const { marker } = buildMarker({ workflowText: validWorkflow });
    const markerText = JSON.stringify(marker);
    const base = { markerText, workflowText: validWorkflow };
    const cases = [
        { name: 'missing-marker-refused', input: { markerText: '', workflowText: validWorkflow }, expect: 'missing-marker' },
        { name: 'invalid-json-refused', input: { markerText: '{nope', workflowText: validWorkflow }, expect: 'marker-invalid' },
        { name: 'arm64-leg-claimed-refused', input: { markerText: JSON.stringify({ ...marker, matrix: { ...marker.matrix, arm64LegPresent: true } }), workflowText: validWorkflow }, expect: 'arm64-leg-still-claimed' },
        { name: 'missing-cross-platform-leg-refused', input: { markerText: JSON.stringify({ ...marker, matrix: { ...marker.matrix, crossPlatformPresent: ['windows-amd64'] } }), workflowText: validWorkflow }, expect: 'cross-platform-legs-missing' },
        { name: 'marker-claiming-execution-refused', input: { markerText: JSON.stringify({ ...marker, execution: { performed: true, evidence: {} } }), workflowText: validWorkflow }, expect: 'execution-claim-without-evidence' },
        { name: 'workflow-still-has-arm64-leg-refused', input: { markerText, workflowText: arm64Workflow }, expect: 'workflow-still-has-arm64-leg' },
        { name: 'workflow-without-limitation-job-refused', input: { markerText, workflowText: validWorkflow.replace('  macos-arm64-recorded-limitation:', '  something-else:') }, expect: 'limitation-job-missing' },
        { name: 'valid-marker-and-workflow-accepted', input: base, expect: null },
    ];
    let failed = 0;
    for (const testCase of cases) {
        const verdict = evaluateLimitation(testCase.input);
        const holds = testCase.expect === null ? verdict.ok : !verdict.ok && verdict.problems.some((problem) => problem.includes(testCase.expect));
        if (holds) console.log(`ok [${testCase.name}]`);
        else {
            failed += 1;
            console.error(`FAIL [${testCase.name}]: expected ${testCase.expect === null ? 'acceptance' : `refusal naming "${testCase.expect}"`}, got ok=${verdict.ok} problems=${JSON.stringify(verdict.problems)}`);
        }
    }
    if (failed > 0) {
        console.error(`FAIL: ${failed} of ${cases.length} macos-arm64 limitation planted cases did not hold`);
        return 1;
    }
    console.log(`macos-arm64 limitation planted cases hold: ${cases.length}/${cases.length}`);
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
    if (command === '--self-test') process.exitCode = selfTest();
    else if (command === 'record') process.exitCode = record({ workflow: options.workflow, out: options.out, evidenceOut: options['evidence-out'] });
    else if (command === 'verify') process.exitCode = verify({ marker: options.marker, workflow: options.workflow, evidenceOut: options['evidence-out'] });
    else if (command === undefined) usage('a command is required');
    else usage(`unknown command ${JSON.stringify(command)}`);
}
