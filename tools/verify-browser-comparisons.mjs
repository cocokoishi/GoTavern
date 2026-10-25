#!/usr/bin/env node
// Verifies the committed browser-comparison artefacts against their own claims.
//
// WHAT THIS CAN AND CANNOT DO, stated first because the difference matters. The per-run leg files
// (startup-*.json, stream-*.json, gen-*.json) are gitignored ON PURPOSE: tests/browser/.gitignore
// records the reason -- "a committed leg invites someone to treat a known divergence as the expected
// value". So a job CANNOT recompute a comparison from its legs in CI, and an earlier attempt at that
// failed with ENOENT. It passed when tried by hand only because the untracked legs happened to be on
// that machine: the working tree, not the repository. That is rule 5 ("verify committed bytes, not
// working-tree bytes") in its most literal form.
//
// WHAT IT CHECKS INSTEAD: that each committed artefact is COHERENT WITH ITSELF and with the claim it
// underwrites. It cannot tell whether the drive ran against today's HEAD -- that is the freshness
// report's job (tools/browser-evidence/freshness.mjs), which has the legs because it just produced them.
//
// THE SHAPE OF THIS FILE. It is a driver, not a checker. Three modules hold the checks:
//   tools/browser-evidence/invariants.mjs       -- what ANY artefact must satisfy, enforced once
//   tools/browser-evidence/catalog-checks.mjs   -- what the SOURCE's catalogue row requires of it
//   tools/browser-evidence/source-hooks.mjs     -- the checks that need one source's wire shape
// and tools/browser-evidence/other-surfaces.mjs holds startup/data-domain/extension, which are a
// different kind of artefact. The gate used to be 1299 lines because every source carried its own copy
// of the same five assertions; a source now costs one catalogue row and, rarely, one hook.
//
// Exit code 1 with a named finding, never a bare failure: "which claim is unsupported" is the only
// useful output of a gate like this.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, sourceForArtifact } from '../tests/browser/sources.mjs';
import { artifactNamesItsSource, driveParametersMatchCatalog, proxyCredentialRow } from './browser-evidence/catalog-checks.mjs';
import {
    bothLegsReached, cancellationReachedProvider, completionRouteUsed, finalTextNonEmpty,
    noDryInvocationInSendWindow, providerRequestsEqual, sendWindowFaithful, streamingSurfacesProven,
} from './browser-evidence/invariants.mjs';
import { assetSurface, dataDomainSurface, extensionSurface, startupSurface } from './browser-evidence/other-surfaces.mjs';
import { SOURCE_HOOKS } from './browser-evidence/source-hooks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserDir = path.resolve(here, '..', 'tests', 'browser');

/** One artifact's finding collector. `scope` prefixes every message with the artefact name. */
function createContext(scope) {
    const findings = [];
    const observations = [];
    const stale = [];
    return {
        scope,
        findings,
        observations,
        stale,
        fail: message => findings.push(`${scope}: ${message}`),
        observe: message => observations.push(message),
        // A STALENESS NOTE IS NOT A FAILURE: it says the artefact predates the current recorder and
        // should be re-recorded, which the freshness report carries. Failing on it would teach people to
        // edit prose instead of re-running the drive.
        noteStale: message => stale.push(message),
    };
}

function readArtifact(file) {
    try {
        return JSON.parse(readFileSync(path.join(browserDir, file), 'utf8'));
    } catch (error) {
        return { __readError: String(error.message ?? error) };
    }
}

/** Runs one artifact through every invariant that applies to its surface. */
function checkGeneration(ctx, source, artifact) {
    bothLegsReached(ctx, artifact, { surface: 'generation' });
    providerRequestsEqual(ctx, artifact);
    sendWindowFaithful(ctx, artifact);
    noDryInvocationInSendWindow(ctx, artifact);
    for (const leg of ['gotavern', 'pinned']) {
        finalTextNonEmpty(ctx, artifact.postSend?.[leg], leg);
    }
    catalogChecks(ctx, source, artifact);
    completionRouteUsed(ctx, artifact, {
        source,
        requestsFor: report => [['gotavern', report.providerRequests?.gotavern], ['pinned', report.providerRequests?.pinned]],
    });
    // Hooks are per-SOURCE and per-SURFACE: the ai21 framing block exists only in the generation
    // artefact, so running that hook against the streaming one reported findings for a record it was
    // never written for. The surface is DECLARED by the hook now -- see runHooks -- rather than inferred
    // from whether the block happens to be present, which let a re-recorded artefact lose the block and
    // still pass (measured on run 40068803201's fresh ai21 artefact).
    runHooks(ctx, source, artifact, 'generation');
}

function checkStreaming(ctx, source, artifact) {
    bothLegsReached(ctx, artifact, { surface: 'streaming' });
    streamingSurfacesProven(ctx, artifact);
    cancellationReachedProvider(ctx, artifact);
    catalogChecks(ctx, source, artifact);
    completionRouteUsed(ctx, artifact, {
        source,
        requestsFor: report => ['streaming', 'cancellation', 'nonstream'].flatMap(surface => [
            [`${surface}.gotavern`, report[surface]?.gotavern?.providerRequests],
            [`${surface}.pinned`, report[surface]?.pinned?.providerRequests],
        ]),
    });
    runHooks(ctx, source, artifact, 'streaming');
}

/**
 * Runs the hooks a source declares FOR THIS SURFACE.
 *
 * A hook applicable to this surface MUST run and MUST find the data it checks; a hook for the other
 * surface is not applicable. That distinction is the whole point: the previous version ran hooks only
 * when a field they wanted happened to exist, so an artefact could lose that field and pass -- which is
 * the absent-check-is-a-pass failure this lane exists to remove, reintroduced one level up.
 */
function runHooks(ctx, source, artifact, surface) {
    for (const hook of source.hooks ?? []) {
        const entry = SOURCE_HOOKS[hook];
        if (!entry) {
            ctx.fail(`declares the hook ${JSON.stringify(hook)}, which tools/browser-evidence/source-hooks.mjs does not implement`);
            continue;
        }
        if (!entry.surfaces.includes(surface)) continue;
        entry.check(ctx, artifact, source);
    }
}

/**
 * The catalogue row's requirements against this artefact.
 *
 * A source the probe CANNOT drive (workers_ai: its drive was removed from the probe and its two
 * artefacts predate that removal) is exempt from the recorder-schema requirements and NOT from the
 * generic invariants above. The exemption is printed every run, with the reason, so it is a stated
 * gap rather than a silent pass: the alternative would be deleting evidence that still passes every
 * source-independent check, or inventing a drive to refresh it.
 */
function catalogChecks(ctx, source, artifact) {
    if (source.driveSupported === false) {
        ctx.observe(`record-schema exemption (not re-recordable today): ${source.unproven}`);
        return;
    }
    driveParametersMatchCatalog(ctx, source, artifact);
    proxyCredentialRow(ctx, source, artifact);
    artifactNamesItsSource(ctx, source, artifact);
}

/** Every host-derived value a committed artefact must not carry. */
const HOST_DERIVED_PATTERNS = [/127\.0\.0\.1/, /localhost:\d+/, /\[::1\]/, /[A-Za-z]:\\\\/, /AppData/i, /\/home\//, /\/tmp\//, /\/Users\//, /\/root\//];

function sweepHostDerived(ctx, text) {
    for (const pattern of HOST_DERIVED_PATTERNS) {
        if (pattern.test(text)) {
            ctx.fail(`records a host-derived address matching ${pattern}; a committed artifact must normalise it to a marker such as <peer-origin> or loopback, because the port belongs to the run that produced it and not to the product`);
        }
    }
}

const main = () => {
    const findings = [];
    const lines = [];

    // ---- 1. THE CHAT-COMPLETION ARTEFACTS, one pass per catalogued source -----------------------
    let checked = 0;
    const verdicts = new Map();
    for (const surface of ['generation', 'streaming']) {
        for (const source of SOURCES) {
            const file = source.evidence?.[surface];
            if (!file) continue;
            checked += 1;
            const ctx = createContext(file);
            const artifact = readArtifact(file);
            if (artifact.__readError) {
                ctx.fail(`cannot be read as JSON (${artifact.__readError})`);
            } else if (surface === 'generation') {
                checkGeneration(ctx, source, artifact);
            } else {
                checkStreaming(ctx, source, artifact);
            }
            findings.push(...ctx.findings);
            verdicts.set(file, ctx.findings.length);
            lines.push(`${ctx.findings.length === 0 ? 'ok  ' : 'FAIL'} ${file} [${source.id}, ${surface}]`);
            for (const observation of ctx.observations) lines.push(`       ${observation}`);
            for (const note of ctx.stale) lines.push(`       STALE ${note}`);
        }
    }

    // ---- 2. THE OTHER SURFACES ------------------------------------------------------------------
    for (const [file, run] of [
        ['startup-comparison.json', startup => startupSurface(startup.ctx, startup.artifact)],
        ['data-domain-comparison.json', data => dataDomainSurface(data.ctx, data.artifact)],
        // THE PICTURE SURFACE (GOAL.md §8.4, AGENTS.md 42-46): avatars, persona thumbnail and the
        // background, asserted from a real browser's DOM and network rather than from a route's status.
        ['asset-comparison.json', asset => assetSurface(asset.ctx, asset.artifact)],
        ['extension-tavern-helper-comparison.json', extension => extensionSurface(extension.ctx, 'extension-tavern-helper-comparison.json', extension.artifact)],
        ['extension-littlewhitebox-comparison.json', extension => extensionSurface(extension.ctx, 'extension-littlewhitebox-comparison.json', extension.artifact)],
    ]) {
        const ctx = createContext(file);
        const payload = readArtifact(file);
        if (payload.__readError) {
            ctx.fail(`cannot be read as JSON (${payload.__readError})`);
        } else {
            run({ ctx, artifact: payload });
        }
        findings.push(...ctx.findings);
        lines.push(`${ctx.findings.length === 0 ? 'ok  ' : 'FAIL'} ${file}`);
        for (const observation of ctx.observations) lines.push(`       ${observation}`);
    }

    // ---- 3. EVERY COMMITTED ARTEFACT IS SWEPT FOR HOST-DERIVED VALUES ---------------------------
    // A loopback port was found in five artefacts while only the comparison fields were being checked,
    // and two more carried it INSIDE a recorded popup HTML -- a field nobody compares, which is exactly
    // where a host-derived value survives review.
    for (const artifactFile of readdirSync(browserDir).filter(name => name.endsWith('-comparison.json'))) {
        const text = readFileSync(path.join(browserDir, artifactFile), 'utf8');
        const ctx = createContext(artifactFile);
        sweepHostDerived(ctx, text);
        findings.push(...ctx.findings);
        if (ctx.findings.length > 0) {
            lines.push(`FAIL ${artifactFile} (host-derived value)`);
            for (const finding of ctx.findings) lines.push(`       ${finding}`);
        }
    }

    // ---- 4. EVERY ARTEFACT BELONGS TO A CATALOGUED SOURCE ---------------------------------------
    // The converse of the catalogue's own coverage rule: an artefact nobody catalogued is an artefact
    // nothing above checked.
    for (const artifactFile of readdirSync(browserDir).filter(name => name.endsWith('-comparison.json'))) {
        const isChatCompletion = /^generation-.*-comparison\.json$/.test(artifactFile) || /^streaming-.*-comparison\.json$/.test(artifactFile);
        if (!isChatCompletion) continue;
        if (!sourceForArtifact(artifactFile)) {
            findings.push(`${artifactFile}: no catalogued source claims this artefact, so none of the invariants above ran against it (add the row to tests/browser/sources.mjs or delete the file)`);
            lines.push(`FAIL ${artifactFile} (uncatalogued)`);
        }
    }

    for (const line of lines) console.log(line);

    if (findings.length > 0) {
        console.error('browser comparison artifacts do not support their claims:');
        for (const finding of findings) console.error(`  - ${finding}`);
        console.error(`\n${findings.length} finding(s) across ${checked} catalogued source artefact(s).`);
        process.exit(1);
    }
    console.log(`browser comparison artifacts are coherent with their claims (${checked} catalogued source artefacts)`);
};

main();
