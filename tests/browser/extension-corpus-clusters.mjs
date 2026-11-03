// CAPABILITY CLUSTERS OVER THE THIRD-PARTY EXTENSION LOCK.
//
// The all-20 surface answers "does the whole pinned corpus load and chat on both subjects?" but it spends
// a full browser leg on every extension and it cannot say WHICH capability class a failure belongs to.
// The cluster mode is the cost-controlled complement: group the corpus by the capability classes the gate
// cares about, and run a deterministic representative PAIR per class. The pair is chosen by LOCK ORDER,
// never by hand, so a rerun of the same lock measures the same two extensions (AGENTS.md: a gate whose
// membership moves when someone edits a list is not a gate).
//
// The vocabulary is the loader's CAPABILITIES set (third-party-extensions.mjs:29-34); an unknown
// capability cannot be silently ignored here either: clustersForLock() records every capability that no
// named cluster claims, so the plan itself says what fell through.
//
// WHY THE PAIR IS TWO. One extension cannot prove a class is comparable on both subjects: a failure on a
// single member could be that extension's own upstream defect. Two members are the smallest set that lets
// the comparator separate "this capability class broke" from "this extension broke", while keeping the
// cost bounded. Members of a class beyond the first two are reported as UNPAIRED, not dropped: the artifact
// must say which extensions this mode did not exercise.

import { CAPABILITIES } from './third-party-extensions.mjs';

// Named classes, in a fixed order (deterministic artifact rows), with the capabilities each one claims.
export const CLUSTER_DEFINITIONS = [
    { name: 'prompt-mutation', capabilities: ['generation', 'prompt-injection', 'prompt-format'] },
    { name: 'render-dom', capabilities: ['message-render', 'markdown', 'DOM'] },
    { name: 'files-network', capabilities: ['files', 'fetch', 'remote-network'] },
    { name: 'settings-events', capabilities: ['settings', 'chat-events'] },
    { name: 'character-world', capabilities: ['character', 'world-info'] },
];

const CLAIMED = new Set(CLUSTER_DEFINITIONS.flatMap(definition => definition.capabilities));

/** Every capability the lock vocabulary knows that no named cluster claims (the "misc" class). */
export function unclaimedCapabilities() {
    return [...CAPABILITIES].filter(capability => !CLAIMED.has(capability)).sort();
}

/**
 * Deterministic clusters over a validated lock.
 *
 * A cluster contains every selected extension whose capabilities intersect it, in lock order. The
 * representative PAIR is the first two members (a one-member cluster records a one-name pair, because
 * inventing a second name would measure an extension the class does not contain).
 *
 * `misc` is not a capability: it is the set of extensions NO named cluster covers, so the artifact can
 * state that the cluster mode did not exercise them.
 */
export function clustersForLock(lock) {
    const selected = lock.selected ?? [];
    const named = CLUSTER_DEFINITIONS.map(definition => {
        const members = selected.filter(extension => (extension.capabilities ?? []).some(capability => definition.capabilities.includes(capability)));
        return {
            name: definition.name,
            capabilities: definition.capabilities,
            members: members.map(extension => extension.name),
            pair: members.slice(0, 2).map(extension => extension.name),
        };
    });
    const covered = new Set(named.flatMap(cluster => cluster.members));
    const unclaimed = new Set(unclaimedCapabilities());
    const miscMembers = selected.filter(extension => (extension.capabilities ?? []).some(capability => unclaimed.has(capability))).map(extension => extension.name);
    const assigned = new Set();
    for (const cluster of named) {
        const fresh = cluster.members.filter(name => !assigned.has(name));
        const ordered = fresh.length >= 2 ? fresh : [...fresh, ...cluster.members.filter(name => !fresh.includes(name))];
        cluster.pair = ordered.slice(0, 2);
        for (const name of cluster.pair) assigned.add(name);
    }
    const miscFresh = miscMembers.filter(name => !assigned.has(name));
    const miscOrdered = miscFresh.length >= 2 ? miscFresh : [...miscFresh, ...miscMembers.filter(name => !miscFresh.includes(name))];
    return {
        named,
        misc: {
            name: 'misc',
            reason: 'extensions exercising a capability that no named cluster claims',
            members: miscMembers.map(extension => extension.name),
            pair: miscOrdered.slice(0, 2),
        },
        capabilityCoverage: {
            claimed: CLUSTER_DEFINITIONS.flatMap(definition => definition.capabilities),
            unclaimed: unclaimedCapabilities(),
        },
    };
}

/** The deterministic pair plan for the cluster mode, with the coverage statement the artifact carries. */
export function clusterPlan(lock) {
    const clusters = clustersForLock(lock);
    const pairs = [...clusters.named, clusters.misc]
        .filter(cluster => cluster.pair.length > 0)
        .map(cluster => ({ cluster: cluster.name, names: cluster.pair, members: cluster.members, pairIsComplete: cluster.pair.length === 2 }));
    const paired = new Set(pairs.flatMap(pair => pair.names));
    const selectedNames = (lock.selected ?? []).map(extension => extension.name);
    // ONE BROWSER RUN PER DISTINCT NAME-LIST, with the clusters that share it recorded on the run.
    const runs = [];
    const byKey = new Map();
    for (const pair of pairs) {
        const key = [...pair.names].sort().join(',');
        if (!byKey.has(key)) {
            byKey.set(key, { key, names: pair.names, clusters: [], members: pair.members, pairIsComplete: pair.pairIsComplete });
            runs.push(byKey.get(key));
        }
        byKey.get(key).clusters.push(pair.cluster);
    }
    return {
        pairs,
        runs,
        paired: [...paired],
        uncovered: selectedNames.filter(name => !paired.has(name)),
        coverage: {
            selectedCount: selectedNames.length,
            pairedCount: paired.size,
            uncoveredCount: selectedNames.filter(name => !paired.has(name)).length,
            statement: paired.size === selectedNames.length
                ? 'every selected extension appears in at least one representative pair'
                : 'the representative pairs cover a subset of the lock; the uncovered extensions are reported by name rather than implied covered (a representative pair is the first two lock-order members of its class, so classes with more than two members leave later members unpaired)',
        },
        clusters: [...clusters.named, clusters.misc],
        capabilityCoverage: clusters.capabilityCoverage,
    };
}

/**
 * The set of names a single corpus leg drives. `all20` and `soak` are the whole lock; `clusters` is the
 * union of the planned pairs (one probe leg carries all pairs for the subject, and the comparator judges
 * per pair from that leg), which keeps the browser cost to one leg per subject per phase while the
 * pairwise membership still comes from clusterPlan().
 */
export function namesForMode(lock, mode) {
    const selected = (lock.selected ?? []).map(extension => extension.name);
    if (mode === 'all20' || mode === 'soak') return selected;
    if (mode === 'clusters') {
        const plan = clusterPlan(lock);
        return plan.pairs.flatMap(pair => pair.names).filter((name, index, all) => all.indexOf(name) === index);
    }
    throw new Error(`unknown corpus mode ${JSON.stringify(mode)}; expected all20, clusters or soak`);
}

/** Resolve a probe `--lock-set` (all20 | cluster:<name>) to names, or null when the argument is absent. */
export function namesForLockSet(lock, lockSet) {
    if (!lockSet) return null;
    if (lockSet === 'all20') return namesForMode(lock, 'all20');
    const match = /^cluster:(.+)$/.exec(lockSet);
    if (!match) throw new Error(`--lock-set must be all20 or cluster:<name>; got ${JSON.stringify(lockSet)}`);
    const name = match[1];
    const plan = clusterPlan(lock);
    const pair = plan.pairs.find(entry => entry.cluster === name);
    if (!pair) throw new Error(`unknown cluster ${JSON.stringify(name)}; known: ${plan.pairs.map(entry => entry.cluster).join(', ')}`);
    return pair.names;
}
