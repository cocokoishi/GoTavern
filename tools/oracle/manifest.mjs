#!/usr/bin/env node
// THE ORACLE DEPENDENCY GRAPH, DEFINED ONCE.
//
// WHAT PROBLEM THIS SOLVES. Until this file existed, "which probes must re-record for this change?"
// was answered twice, by two different greps: `.github/workflows/ci.yml:113-139` (a bash regex plus a
// `grep -l "fixture=..."` filename heuristic) and `scripts/dev-verify.mjs:88` (an unanchored, first-match
// regex that only learns one fixture per probe). Neither was a definition of the dependency graph, and
// both were incomplete: `ci.yml` skipped the whole oracle job for `internal/**`, `cmd/**` and
// `tools/*/main.go`, although ~20 probes `go run` a repo Go helper and record its output, and
// `sillytavern-1.19.0-runtime-roundtrip.json` records three `"subject": "gotavern"` steps. A change
// under `tools/image-metadata-roundtrip/main.go` therefore re-recorded nothing at all.
//
// WHAT THIS FILE IS. One parse of the declarations the probes already carry, one derivation of what
// each probe actually reads, and one `validate()` that refuses a manifest which is not a total
// function from committed fixture -> exactly one owner. `tools/oracle/plan.mjs` turns it into a
// decision; `.github/workflows/ci.yml` only produces a changed-file list and prints the plan.
//
// WHAT IT IS NOT. It is not the runner. It does not execute a probe, and it must not: the fixtures
// are recorded by `tools/build-generated-lib.mjs`, which is being refactored in a parallel change.
// This module only reads the repository.
//
// USAGE
//   node tools/oracle/manifest.mjs --validate      # exit 1 and name every broken invariant
//   node tools/oracle/manifest.mjs --dump          # the derived graph as JSON (for review, not for CI)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const repositoryRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// THE DECLARATION FORMAT IS THE GENERATOR'S, COPIED DELIBERATELY AND LINE-FOR-LINE.
//
// Source of truth while the runner still discovers probes itself:
//   tools/build-generated-lib.mjs:346  const declaration = /^\/\/ @gotavern-oracle: (.*)$/.exec(line.trim());
//   tools/build-generated-lib.mjs:347  if (!declaration || !declaration[1].includes('fixture=')) continue;
//   tools/build-generated-lib.mjs:349  for (const match of declaration[1].matchAll(/(\w+)=("[^"]*"|\S+)/g))
//   tools/build-generated-lib.mjs:350  fields[match[1]] = match[2].replace(/^"|"$/g, '');
//   tools/build-generated-lib.mjs:352-362  fixture / label ?? fixture / args.split(',') / sharedWrite === 'true'
//
// If the two ever disagree, `validate()` fails on the count instead of the selection quietly drifting:
// `validate` re-derives the declaration count here and the test in `tests/oracle/plan.test.mjs` pins
// this file's own count to the committed fixture set.
const DECLARATION_LINE = /^\/\/ @gotavern-oracle: (.*)$/;
const DECLARATION_FIELD = /(\w+)=("[^"]*"|\S+)/g;

// Fields this manifest understands. Anything else a declaration carries is reported, not ignored:
// `tools/build-generated-lib.mjs:349-362` parses every `key=value` and then silently drops all but
// four, so writing `serial=...` there today is accepted syntax that does nothing. Here it is an error.
const KNOWN_DECLARATION_FIELDS = new Set(['fixture', 'label', 'args', 'sharedWrite', 'inputs']);

// A FIXTURE WITH NO PROBE OWNER IS NOT AUTOMATICALLY AN ORPHAN.
//
// Some fixtures are legitimately not produced by `tools/probe-*.mjs`: a fixture recorded by a
// one-off, an upstream capture, or a fixture a future generator writes. Classifying it here keeps
// "no owner" from meaning two different things, so an actual orphan still fails the gate. The value
// must be `external` (recorded outside the probe set) or `generated` (produced by a script, not a
// probe); the reason is printed beside the classification in `--dump`.
export const FIXTURE_CLASSIFICATIONS = new Map([
    // Empty at HEAD: all 118 committed fixtures are owned by exactly one declaration, so the
    // distinction is enforced without currently excusing anything.
]);

// A fixture written by more than one probe must say so, because two writers of one file means the
// last probe to run decides its bytes and the double-run comparison is meaningless. Empty at HEAD.
export const SHARED_FIXTURES = new Map([
    // 'sillytavern-1.19.0-<name>.json': ['<probe-id>', '<probe-id>'],
]);

// ---------------------------------------------------------------------------------------------
// INPUT DERIVATION
//
// Every entry here is a fact read from the probe's own source, and every one of them is a real edge
// that the old `ci.yml` regex could not see. The derivation is intentionally textual: a probe is a
// script, and what it reads is written in it. Each rule names the token it keyed on so a reviewer can
// audit the graph rather than trust it.
// ---------------------------------------------------------------------------------------------

const TOOLS_LIB_IMPORT = /from '\.\/lib\/[^']+'/;
const GO_HELPER_REFERENCE = /\.\/tools\/([a-z0-9][a-z0-9-]*)/g;
const GO_HELPER_INVOCATION = /'go',\s*\[\s*'(?:run|build)'/;
const GO_PRODUCT_BINARY = /GOTAVERN_BINARY|'\.\/cmd\/gotavern'|cmd\/gotavern/;
// A repository script (`scripts/<name>.mjs|.sh|.ps1`) a probe names. Extensions are restricted to the
// three repository script types on purpose: this must not turn the pinned server's URL path
// `public/scripts/extensions/...` into an input. At HEAD no probe references one (28 lines match
// `scripts/`, every one of them that URL path); the rule exists so the planner's `scripts/` entry can
// never hide a future edge, because an input always outranks the irrelevant allowlist.
const REPOSITORY_SCRIPT_REFERENCE = /scripts\/([A-Za-z0-9._-]+\.(?:mjs|sh|ps1))/g;

/**
 * Derive the inputs of one probe from its source text.
 *
 * Returned inputs are repository-relative posix paths ending in `/` for directories, plus the
 * pseudo-input `go-product` which stands for "the GoTavern/Go build of this repository". A changed
 * Go file under internal/ or cmd/ is attributed through it.
 *
 * `declaredInputs` (an `inputs=a,b` declaration field) REPLACES the derivation for that declaration
 * and is required to include the probe's own script, so a hand-written list cannot make a probe
 * forget the file it is. The declaration format is "added fields only": no probe carries `inputs=`
 * at HEAD, and the fallback below is the whole graph until one does.
 */
export function deriveInputs({ script, source, declaredInputs = null }) {
    const scriptPath = `tools/${script}`;
    if (declaredInputs && declaredInputs.length > 0) {
        const inputs = declaredInputs.map(value => value.trim()).filter(value => value !== '');
        return {
            resolution: 'declared',
            inputs: [...new Set(inputs)],
            goProduct: inputs.includes('go-product'),
        };
    }
    const inputs = new Set([scriptPath]);
    const evidence = [];
    if (TOOLS_LIB_IMPORT.test(source)) {
        inputs.add('tools/lib/');
        evidence.push("imports './lib/'");
    }
    if (source.includes("'provider-wire'") && source.includes("'scenarios'")) {
        inputs.add('tests/provider-wire/scenarios/');
        evidence.push('reads tests/provider-wire/scenarios');
    }
    for (const match of source.matchAll(GO_HELPER_REFERENCE)) {
        inputs.add(`tools/${match[1]}/`);
        evidence.push(`references ./tools/${match[1]}`);
    }
    for (const match of source.matchAll(REPOSITORY_SCRIPT_REFERENCE)) {
        inputs.add(`scripts/${match[1]}`);
        evidence.push(`references scripts/${match[1]}`);
    }
    // A probe that runs a repository Go helper, or that drives the GoTavern binary, records output
    // produced by Go code in this repository. `internal/**` and `cmd/**` therefore move its fixture.
    // This is the edge the old selection did not have, and its absence is why a Go change could not
    // re-record anything.
    const goProduct = GO_PRODUCT_BINARY.test(source) || GO_HELPER_INVOCATION.test(source);
    if (goProduct) {
        inputs.add('go-product');
        evidence.push(GO_HELPER_INVOCATION.test(source) ? "runs a repo Go helper ('go run'/'go build')" : 'drives the GoTavern binary');
    }
    return { resolution: 'derived', inputs: [...inputs].sort(), goProduct, evidence };
}

function probeIdFor(script) {
    return script.replace(/^probe-/, '').replace(/\.mjs$/, '');
}

/**
 * Parse every declaration in one probe source the way the generator does.
 * Returns entries plus the declaration-looking lines that were skipped, so a typo is visible.
 */
export function parseDeclarations({ script, source }) {
    const entries = [];
    const skipped = [];
    const unknownFields = [];
    for (const rawLine of source.split('\n')) {
        const line = rawLine.trim();
        const declaration = DECLARATION_LINE.exec(line);
        if (!declaration) continue;
        if (!declaration[1].includes('fixture=')) {
            // The boilerplate form is "// @gotavern-oracle: this declaration is read by ...". Anything
            // that mentions a fixture but does not parse is a broken declaration, not prose.
            if (/fixture/i.test(declaration[1])) skipped.push(line);
            continue;
        }
        const fields = {};
        for (const match of declaration[1].matchAll(DECLARATION_FIELD)) {
            fields[match[1]] = match[2].replace(/^"|"$/g, '');
        }
        for (const name of Object.keys(fields)) {
            if (!KNOWN_DECLARATION_FIELDS.has(name)) unknownFields.push({ script, name, line });
        }
        entries.push({
            probe: probeIdFor(script),
            script,
            fixture: fields.fixture,
            label: fields.label ?? fields.fixture,
            args: fields.args ? fields.args.split(',') : [],
            sharedWrite: fields.sharedWrite === 'true',
            declaredInputs: fields.inputs ? fields.inputs.split(',') : null,
        });
    }
    return { entries, skipped, unknownFields };
}

/** Wrap a plain list of parts into the manifest shape `validate` consumes. */
export function createManifest({
    repositoryRoot = repositoryRootDefault,
    scripts = [],
    fixtures = [],
    entries = [],
    classifications = FIXTURE_CLASSIFICATIONS,
    sharedFixtures = SHARED_FIXTURES,
    skippedDeclarationLines = [],
    unknownDeclarationFields = [],
} = {}) {
    return {
        repositoryRoot,
        scripts: [...scripts].sort(),
        fixtures: [...fixtures].sort(),
        entries,
        classifications,
        sharedFixtures,
        skippedDeclarationLines,
        unknownDeclarationFields,
    };
}

/** Read the repository and derive the whole graph. */
export function buildManifest({ repositoryRoot = repositoryRootDefault, classifications, sharedFixtures } = {}) {
    const toolsDirectory = path.join(repositoryRoot, 'tools');
    const scripts = readdirSync(toolsDirectory)
        .filter(name => name.startsWith('probe-') && name.endsWith('.mjs'))
        .sort();
    const fixturesDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    const fixtures = existsSync(fixturesDirectory)
        ? readdirSync(fixturesDirectory).filter(name => name.endsWith('.json')).sort()
        : [];

    const entries = [];
    const skippedDeclarationLines = [];
    const unknownDeclarationFields = [];
    for (const script of scripts) {
        const source = readFileSync(path.join(toolsDirectory, script), 'utf8');
        const parsed = parseDeclarations({ script, source });
        skippedDeclarationLines.push(...parsed.skipped.map(line => ({ script, line })));
        unknownDeclarationFields.push(...parsed.unknownFields);
        for (const entry of parsed.entries) {
            const derived = deriveInputs({ script, source, declaredInputs: entry.declaredInputs });
            entries.push({
                ...entry,
                inputs: derived.inputs,
                resolution: derived.resolution,
                goProduct: derived.goProduct,
                evidence: derived.evidence ?? [],
            });
        }
    }
    return createManifest({
        repositoryRoot,
        scripts,
        fixtures,
        entries,
        classifications: classifications ?? FIXTURE_CLASSIFICATIONS,
        sharedFixtures: sharedFixtures ?? SHARED_FIXTURES,
        skippedDeclarationLines,
        unknownDeclarationFields,
    });
}

// ---------------------------------------------------------------------------------------------
// INVARIANTS
//
// Every check has a stable `code`, because a gate is only as good as one's ability to name the
// assertion that goes red when it is removed. The mutation table in the PR body cites these codes.
// ---------------------------------------------------------------------------------------------

export function validate(manifest) {
    const errors = [];
    const warnings = [];
    const error = (code, subject, message) => errors.push({ code, subject, message });

    const scriptsOnDisk = new Set(manifest.scripts);
    const fixturesOnDisk = new Set(manifest.fixtures);
    const ownersByFixture = new Map();
    const seenDeclarations = new Map();
    const probeIds = new Map();

    for (const entry of manifest.entries) {
        const key = `${entry.script}::${entry.fixture}`;
        if (seenDeclarations.has(key)) {
            error('duplicate-declaration', key,
                `${entry.script} declares ${entry.fixture} twice; one run would overwrite the other and the second comparison would be meaningless`);
        }
        seenDeclarations.set(key, entry);

        if (!scriptsOnDisk.has(entry.script)) {
            error('dangling-script', entry.script,
                `a declaration names ${entry.script}, which does not exist in tools/`);
        }
        if (!fixturesOnDisk.has(entry.fixture)) {
            error('dangling-fixture', entry.fixture,
                `${entry.script} declares ${entry.fixture}, which is not committed in tests/oracle/`);
        }
        const previousProbe = probeIds.get(entry.probe);
        if (previousProbe !== undefined && previousProbe !== entry.script) {
            error('probe-id-collision', entry.probe,
                `${entry.probe} is produced by both ${previousProbe} and ${entry.script}`);
        }
        probeIds.set(entry.probe, entry.script);

        if (!Array.isArray(entry.inputs) || entry.inputs.length === 0) {
            error('empty-inputs', entry.script, 'a probe with no inputs cannot be selected by any change');
        } else if (entry.resolution === 'declared' && !entry.inputs.includes(`tools/${entry.script}`)) {
            // An explicit `inputs=` list is allowed to replace the derivation, but it must not be
            // allowed to make the probe forget the file that IS the probe.
            error('declared-inputs-omit-self', entry.script,
                `inputs= on ${entry.script} does not include tools/${entry.script}`);
        }

        const owners = ownersByFixture.get(entry.fixture) ?? [];
        owners.push(entry.probe);
        ownersByFixture.set(entry.fixture, owners);
    }

    // Every committed fixture has exactly one owner, or an explicit classification saying why not.
    for (const fixture of manifest.fixtures) {
        const owners = ownersByFixture.get(fixture) ?? [];
        const classification = manifest.classifications.get(fixture);
        if (owners.length === 0) {
            if (classification === undefined) {
                error('orphan-fixture', fixture,
                    `${fixture} is committed but no probe declares it; add a declaration or classify it as external/generated in tools/oracle/manifest.mjs`);
            }
            continue;
        }
        if (classification !== undefined) {
            error('stale-classification', fixture,
                `${fixture} is classified as ${classification} but ${owners.join(', ')} owns it; remove the classification`);
        }
        if (owners.length > 1) {
            const declared = manifest.sharedFixtures.get(fixture);
            if (declared === undefined) {
                error('multi-writer-undeclared', fixture,
                    `${fixture} is written by ${owners.join(', ')}; declare it in SHARED_FIXTURES so its bytes have one authority`);
            } else {
                const declaredSet = [...declared].sort().join(',');
                const actualSet = [...owners].sort().join(',');
                if (declaredSet !== actualSet) {
                    error('stale-shared-fixture', fixture,
                        `SHARED_FIXTURES lists ${declaredSet} for ${fixture} but the declarations say ${actualSet}`);
                }
            }
        }
    }

    for (const [fixture, classification] of manifest.classifications) {
        if (classification !== 'external' && classification !== 'generated') {
            error('unknown-classification', fixture,
                `classification '${classification}' must be 'external' or 'generated'`);
        }
    }

    // Every probe script must declare at least one run: a probe that declares nothing is invisible
    // to selection, which is the discovery hole the generator already refuses at run time.
    const declaredScripts = new Set(manifest.entries.map(entry => entry.script));
    for (const script of manifest.scripts) {
        if (!declaredScripts.has(script)) {
            error('undeclared-probe', script,
                `${script} declares no @gotavern-oracle run, so no change can ever select it`);
        }
    }

    if (manifest.skippedDeclarationLines.length > 0) {
        for (const skipped of manifest.skippedDeclarationLines) {
            error('broken-declaration', skipped.script,
                `this declaration line does not parse (the generator would skip it): ${skipped.line}`);
        }
    }
    for (const unknown of manifest.unknownDeclarationFields) {
        // Not an error: the generator ignores extra fields today. It is a warning because a field
        // that looks meaningful and does nothing is how an option becomes decoration.
        warnings.push({
            code: 'ignored-declaration-field',
            subject: `${unknown.script}:${unknown.name}`,
            message: `field '${unknown.name}' is parsed by nothing; use inputs= if it is meant to affect selection`,
        });
    }
    if (manifest.entries.length === 0) {
        error('empty-manifest', 'tools/', 'no declarations were found; every selection would be vacuously empty');
    }

    return { ok: errors.length === 0, errors, warnings };
}

export function describeValidation(result) {
    const lines = [];
    for (const entry of result.errors) lines.push(`ERROR ${entry.code} [${entry.subject}] ${entry.message}`);
    for (const entry of result.warnings) lines.push(`WARN  ${entry.code} [${entry.subject}] ${entry.message}`);
    return lines.join('\n');
}

function main(argv) {
    const manifest = buildManifest();
    if (argv.includes('--validate')) {
        const result = validate(manifest);
        console.log(`oracle manifest: ${manifest.entries.length} declaration(s) across ${manifest.scripts.length} probe script(s), ${manifest.fixtures.length} committed fixture(s)`);
        const prose = describeValidation(result);
        if (prose) console.log(prose);
        if (!result.ok) {
            console.error(`oracle manifest is not a total function from fixture to owner: ${result.errors.length} error(s)`);
            return 1;
        }
        console.log('oracle manifest is consistent');
        return 0;
    }
    if (argv.includes('--dump')) {
        console.log(JSON.stringify({
            declarations: manifest.entries.length,
            scripts: manifest.scripts.length,
            fixtures: manifest.fixtures.length,
            entries: manifest.entries.map(entry => ({
                probe: entry.probe,
                script: entry.script,
                fixture: entry.fixture,
                args: entry.args,
                sharedWrite: entry.sharedWrite,
                resolution: entry.resolution,
                goProduct: entry.goProduct,
                inputs: entry.inputs,
            })),
            classifications: Object.fromEntries(manifest.classifications),
            sharedFixtures: Object.fromEntries(manifest.sharedFixtures),
        }, null, 2));
        return 0;
    }
    console.error('usage: node tools/oracle/manifest.mjs --validate | --dump');
    return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
