// THE PINNED EXTENSION BATCH: ONE implementation of "install the E04 extension set into a data root before boot".
//
// WHY THIS FILE EXISTS. Two drivers need the same thing: the E03+E04 combination-journey profile
// (`combination-journey-probe.mjs --profile e03e04`, full tier = all 22 pinned extensions) and the third-party
// extension lifecycle driver (`third-party-extensions-run.mjs`, which installs one extension per row). A second
// copy of the install loop would let one driver verify a revision and the other not, so the pin could move in one
// lane and stay frozen in the other. This module is the extracted helper: it composes the ALREADY-PROVEN
// primitives instead of reimplementing them --
//   * `tests/browser/install-pinned-extension.mjs` `ensurePinnedExtensionInstalled` (the one install primitive:
//     pinned commit, branch checkout, frozen local-mirror origin so a page-triggered auto-update cannot advance
//     the pin, optional `GOTAVERN_EXTENSION_SEED_ROOT` seed copy),
//   * `tests/browser/third-party-extensions.mjs` `loadLock` (the 20-extension corpus lock, validated before
//     anything boots),
//   * `tests/browser/pinned-extensions.mjs` `pinnedExtension` (the two canaries named by AGENTS.md rule 15).
// Nothing here is extension-specific and nothing here decides a product behaviour; it installs files and reports
// what it installed.
//
// THE SET. Full tier is exactly 22: the two pinned canaries (Tavern Helper / JS-Slash-Runner, LittleWhiteBox) plus
// the 20 lock-selected client extensions. The design's tiers (docs/alpha16/first-scenario-design.md section 7) are
// fast = 3, medium = 10, full = 22:
//   * fast: Tavern Helper + the first two lock entries in lock order. The design's fast tier hoped for two
//     no-wire-effect corpus entries, but MEASURED HERE the committed lock's twenty selected extensions ALL declare a
//     wire-relevant capability, so the fast tier installs the first two in lock order and the per-extension record
//     says `capability-relevant-unproven` instead of pretending they are quiet. A deterministic subset is the point;
//     the classification stays honest.
//   * medium: the two canaries + the first eight lock entries in lock order (deterministic, never "whatever is
//     installed");
//   * full: all 22.
// A tier is a COST choice, never a strength claim: the run's identity records `extensionTier`, `installed` count
// and `expected` count, and a narrowed run must not be reported as full coverage.
//
// CALLERS. This task wires `combination-journey-probe.mjs`. `third-party-extensions-run.mjs` keeps its own local
// `installIntoRoot` shim ONE more task: this task's write scope does not include that file, and editing it would
// violate the "only task-14 write-scope files" constraint. The API is deliberately shaped so that migration is a
// drop-in: `installExtensionBatch` returns, per extension, the same `{ extensionDirectory, revision, source }` the
// shim returns, and accepts a `seedRoot` override for `GOTAVERN_EXTENSION_SEED_ROOT`. The residual risk is stated
// in the lane report: until that migration lands there are two call sites, both delegating to the SAME primitive
// (`ensurePinnedExtensionInstalled`), so the install/pin logic itself is not duplicated.
//
// CLI (thin, import-safe when used as a module):
//   node tests/browser/extensions/extension-install-batch.mjs --data-root <dir> [--tier fast|medium|full]
//   node tests/browser/extensions/extension-install-batch.mjs --tier full --seed-out <dir>
// The `--seed-out` form installs once into a scratch data root and prints the extensions root a later step should
// export as GOTAVERN_EXTENSION_SEED_ROOT, so a workflow pays one network install and each leg copies locally.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadLock } from '../third-party-extensions.mjs';
import { PINNED_EXTENSIONS, pinnedExtension } from '../pinned-extensions.mjs';
import { describeInstalledExtension, ensurePinnedExtensionInstalled, installedRevision, userExtensionsDirectory } from '../install-pinned-extension.mjs';

export const EXTENSION_TIERS = Object.freeze({ fast: 3, medium: 10, full: 22 });

/** Capabilities whose extension can change the outbound request; the rest are declared no-wire-effect. */
export const WIRE_CAPABILITIES = Object.freeze(['generation', 'prompt-injection', 'prompt-format', 'world-info', 'chat-events']);

const here = path.dirname(fileURLToPath(import.meta.url));

/** A descriptor is the minimal install identity: directory name, remote, pinned commit, branch, provenance. */
function descriptorForCanary(key) {
    const extension = pinnedExtension(key);
    return {
        key,
        name: extension.name,
        label: extension.label,
        url: extension.repo,
        commit: extension.commit,
        branch: 'main',
        source: 'pinned-canary',
        capabilities: [],
    };
}

function descriptorForLockEntry(entry) {
    return {
        key: entry.name,
        name: entry.name,
        label: entry.name,
        url: entry.url,
        commit: entry.commit,
        branch: entry.branch ?? 'main',
        source: 'corpus-lock',
        capabilities: [...(entry.capabilities ?? [])],
    };
}

function isWireRelevant(descriptor) {
    return (descriptor.capabilities ?? []).some(capability => WIRE_CAPABILITIES.includes(capability));
}

/**
 * The EXPLICIT per-extension effect classification the scenario records instead of inventing a provider marker.
 * Design section 8: extensions with no provider-visible effect are recorded as `no-wire-effect` WITH their
 * evidence, never silently skipped; extensions whose capability set touches the request are recorded as
 * `capability-relevant-unproven` for THIS scenario unless the probe later observes their own marker. The
 * comparator asserts this record exists for every installed extension (`extension-effect-<name>`), so a missing
 * row is a red guard, not a footnote.
 */
export function wireEffectFor(descriptor) {
    if (isWireRelevant(descriptor)) {
        return {
            status: 'capability-relevant-unproven',
            evidence: `capabilities [${descriptor.capabilities.join(',')}] touch the outbound request; this scenario drives the shared turn and records its body, it does not attribute a marker to this extension and must not infer one`,
        };
    }
    return {
        status: 'no-wire-effect',
        evidence: `capabilities [${descriptor.capabilities.join(',') || 'none declared'}] declare no generation/prompt-injection/prompt-format/world-info/chat-events surface, so this scenario invents no provider marker for it (design section 8)`,
    };
}

/** The deterministic tier plan. Throws on a tier whose size the corpus cannot satisfy rather than shrinking it. */
export function extensionPlan(tier = 'full') {
    if (!Object.hasOwn(EXTENSION_TIERS, tier)) {
        throw new Error(`unknown extension tier ${JSON.stringify(tier)}; known: ${Object.keys(EXTENSION_TIERS).join(', ')}`);
    }
    const { lock, sha256 } = loadLock();
    const canaries = [descriptorForCanary('tavern-helper'), descriptorForCanary('littlewhitebox')];
    const corpus = lock.selected.map(descriptorForLockEntry);
    let selected;
    if (tier === 'fast') {
        // The first two lock entries in lock order: deterministic, real third-party code, no "whatever is installed".
        // (The corpus has no no-wire-effect entry: every selected extension declares a wire-relevant capability, which
        // `wireEffectFor` records honestly.)
        selected = [canaries[0], ...corpus.slice(0, 2)];
    } else if (tier === 'medium') {
        selected = [...canaries, ...corpus.slice(0, EXTENSION_TIERS.medium - canaries.length)];
    } else {
        selected = [...canaries, ...corpus];
    }
    if (selected.length !== EXTENSION_TIERS[tier]) {
        throw new Error(`extension tier ${tier} planned ${selected.length} extensions, expected ${EXTENSION_TIERS[tier]}`);
    }
    const names = new Set();
    for (const descriptor of selected) {
        if (names.has(descriptor.name)) throw new Error(`extension tier ${tier} plans ${descriptor.name} twice`);
        names.add(descriptor.name);
    }
    return { tier, lockSha256: sha256, selected };
}

/**
 * Install the tier's extensions into `<dataRoot>/default-user/extensions/<name>`.
 *
 * FAIL-CLOSED: each installed checkout's revision is re-read and compared with the pinned commit (`ensurePinned
 * ExtensionInstalled` already guarantees it, and this re-read is the independent check that the guarantee survives
 * a future refactor), and ANY mismatch throws naming the extension. A batch that installed 21 of 22 must not
 * produce a leg that calls itself full-tier.
 *
 * `seedRoot`, when given, is exported as GOTAVERN_EXTENSION_SEED_ROOT for the duration of the call and restored
 * afterwards (the same env discipline `third-party-extensions-run.mjs` uses), so a CI run can seed once and copy.
 */
export async function installExtensionBatch({ dataRoot, tier = 'full', seedRoot = null, plan = null } = {}) {
    if (typeof dataRoot !== 'string' || dataRoot.trim() === '') throw new Error('installExtensionBatch requires a dataRoot');
    const resolvedPlan = plan ?? extensionPlan(tier);
    const previousSeed = process.env.GOTAVERN_EXTENSION_SEED_ROOT;
    if (seedRoot) process.env.GOTAVERN_EXTENSION_SEED_ROOT = path.resolve(seedRoot);
    const installed = [];
    try {
        for (const descriptor of resolvedPlan.selected) {
            const result = await ensurePinnedExtensionInstalled(dataRoot, descriptor);
            const revision = await installedRevision(result.extensionDirectory);
            if (revision !== descriptor.commit) {
                throw new Error(`batch install left ${descriptor.name} at ${revision}, not the pinned ${descriptor.commit}`);
            }
            const described = await describeInstalledExtension(result.extensionDirectory);
            installed.push({
                name: descriptor.name,
                commit: descriptor.commit,
                branch: descriptor.branch,
                source: descriptor.source,
                url: descriptor.url,
                capabilities: descriptor.capabilities,
                install: { source: result.source, remote: result.remote, revision: result.revision },
                directory: path.relative(dataRoot, result.extensionDirectory).split(path.sep).join('/'),
                manifest: described,
                wireEffect: wireEffectFor(descriptor),
            });
        }
        // Independent post-conditions: the tree contains every planned directory and nothing is at a different
        // revision. Read the DIRECTORY, not the plan.
        const extensionsRoot = userExtensionsDirectory(dataRoot);
        const present = new Set(await fs.readdir(extensionsRoot).catch(() => []));
        const missing = resolvedPlan.selected.filter(descriptor => !present.has(descriptor.name)).map(descriptor => descriptor.name);
        if (missing.length > 0) throw new Error(`batch install is missing installed directories: ${missing.join(', ')}`);
        return {
            kind: 'extension-install-batch',
            schemaVersion: 1,
            tier: resolvedPlan.tier,
            expected: resolvedPlan.selected.length,
            installedCount: installed.length,
            lockSha256: resolvedPlan.lockSha256,
            extensionsRoot: path.relative(dataRoot, extensionsRoot).split(path.sep).join('/'),
            installed,
        };
    } finally {
        if (previousSeed === undefined) delete process.env.GOTAVERN_EXTENSION_SEED_ROOT;
        else process.env.GOTAVERN_EXTENSION_SEED_ROOT = previousSeed;
    }
}

/** A compact record for a leg report: the batch identity plus the per-extension effect classification. */
export function extensionBatchRecord(batch) {
    return {
        tier: batch.tier,
        expected: batch.expected,
        installedCount: batch.installedCount,
        lockSha256: batch.lockSha256,
        extensionsRoot: batch.extensionsRoot,
        installed: batch.installed.map(entry => ({
            name: entry.name,
            commit: entry.commit,
            source: entry.source,
            directory: entry.directory,
            wireEffect: entry.wireEffect,
        })),
    };
}

function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1];
}

async function main() {
    const tier = argumentValue('--tier') ?? 'full';
    const seedOut = argumentValue('--seed-out');
    let dataRoot = argumentValue('--data-root');
    if (seedOut) {
        dataRoot = path.resolve(seedOut);
        await fs.rm(dataRoot, { recursive: true, force: true });
    }
    if (!dataRoot) {
        console.error('usage: node extension-install-batch.mjs --data-root <dir> [--tier fast|medium|full]');
        console.error('       node extension-install-batch.mjs --seed-out <dir> [--tier fast|medium|full]');
        process.exit(2);
    }
    await fs.mkdir(dataRoot, { recursive: true });
    const batch = await installExtensionBatch({ dataRoot, tier });
    const summary = {
        ...extensionBatchRecord(batch),
        dataRoot: path.resolve(dataRoot),
        seedRoot: seedOut ? userExtensionsDirectory(path.resolve(dataRoot)) : null,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (seedOut) console.error(`[extension-batch] seed root: ${summary.seedRoot}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    await main();
}
