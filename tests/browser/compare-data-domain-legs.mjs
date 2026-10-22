#!/usr/bin/env node
// Compare the data-domain drive reports from both legs (two runs per leg).
//
//   node compare-data-domain-legs.mjs \
//        data-domain-gotavern-1.json data-domain-gotavern-2.json \
//        data-domain-pinned-1.json data-domain-pinned-2.json
//
// Per interaction, three things are compared:
//   1. the HTTP traffic it caused — method+path membership, statuses, and the WRITE PAYLOAD digest,
//      which is the evidence that both legs were driven the same way;
//   2. the response body digest of each request, compared only where BOTH RUNS OF EACH LEG agree,
//      the same determinism rule compare-startup-legs.mjs uses: a body that changes between two
//      identical drives is not a compatibility signal;
//   3. the `observed` values the frontend ended up holding — the E surface itself.
//
// A non-equal row records the route's inventory status, so a known-unimplemented difference is cited
// rather than assumed, and an UNEXPECTED difference (no inventory row) is called out.
//
// The comparison exits non-zero when any interaction that was DRIVEN ON BOTH LEGS differs, because
// that is the condition under which a coverage cell must not be promoted.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const [gotavernFirstPath, gotavernSecondPath, pinnedFirstPath, pinnedSecondPath] = process.argv.slice(2);
if (!gotavernFirstPath || !gotavernSecondPath || !pinnedFirstPath || !pinnedSecondPath) {
    console.error('usage: node compare-data-domain-legs.mjs <gotavern-1.json> <gotavern-2.json> <pinned-1.json> <pinned-2.json>');
    process.exit(2);
}

const load = async file => JSON.parse(await fs.readFile(file, 'utf8'));

const parseInventory = async () => {
    const statuses = new Map();
    try {
        const text = await fs.readFile(path.resolve('..', '..', 'docs', 'api-inventory.md'), 'utf8');
        for (const line of text.split('\n')) {
            const cells = line.split('|').map(cell => cell.trim());
            if (cells.length < 5 || !cells[2].startsWith('/')) continue;
            const method = cells[1].replace(/`/g, '').toUpperCase();
            const route = cells[2].replace(/`/g, '');
            const status = cells[4].replace(/\*\*/g, '').split(':')[0].trim();
            if (method && route && status) statuses.set(`${method} ${route}`, status);
        }
    } catch {
        // No inventory is not a failure of this comparison; rows then report `unknown`.
    }
    return statuses;
};

const interactionsById = report => new Map((report.interactions ?? []).map(entry => [entry.id, entry]));

// Requests are attributed to an interaction by the slice of traffic it caused, but the frontend also
// issues AMBIENT requests while a drive is running (background loading, rendering, polling), and
// those land in whichever slice the timing puts them in. Comparing them would report a scheduling
// artifact as a compatibility difference, so each interaction compares only its own domain's paths
// and records the ambient ones separately, by count.
const DOMAIN_PATH = {
    settings: '/api/settings/',
    characters: '/api/characters/',
    chats: '/api/chats/',
    backgrounds: '/api/backgrounds/',
    quickReplies: '/api/quick-replies/',
};

// The thumbnail route is the documented image-codec boundary: `/thumbnail/<computed>` is
// `not implemented` in GoTavern by an explicit product decision (AGENTS.md architecture boundary 3),
// so a thumbnail difference is CITED rather than counted as an unexpected data-domain difference.
const CITED_BOUNDARIES = [
    { match: path => path.startsWith('/thumbnail'), reason: 'thumbnail codec boundary: /thumbnail/<computed> is not implemented (AGENTS.md architecture boundary 3)' },
];

// A drive only demonstrates a WRITE if it issued a request that changes data. Every route in these
// domains is POST, so the read routes are named explicitly and anything else counts as a write. This
// is what stops a read-only interaction being promoted: an interaction whose "write" never landed
// cannot fail on a difference, because nothing was written to differ.
const READ_ROUTE_SUFFIXES = ['/all', '/get', '/recent', '/folders', '/status', '/info', '/chats', '/discover', '/export', '/version'];
const isWriteRequest = request => request.method === 'POST' && !READ_ROUTE_SUFFIXES.some(suffix => request.path.endsWith(suffix));

const citationFor = path => CITED_BOUNDARIES.find(entry => entry.match(path))?.reason ?? null;

// Two runs of one leg are compared per request occurrence, keyed by method+path. Membership is
// compared, counts are recorded: a render loop can issue the same request a different number of
// times without that being a compatibility signal.
const legRequests = (first, second) => {
    const index = (entry, key) => {
        const groups = new Map();
        for (const request of entry?.requests ?? []) {
            const requestKey = `${request.method} ${request.path}`;
            if (!groups.has(requestKey)) groups.set(requestKey, []);
            groups.get(requestKey).push(request);
        }
        return groups;
    };
    const firstGroups = index(first);
    const secondGroups = index(second);
    const keys = new Set([...firstGroups.keys(), ...secondGroups.keys()]);
    const result = new Map();
    for (const key of keys) {
        const a = firstGroups.get(key) ?? [];
        const b = secondGroups.get(key) ?? [];
        const last = list => (list.length ? list[list.length - 1] : null);
        const stableBody = Boolean(last(a)?.bodySha256) && last(a)?.bodySha256 === last(b)?.bodySha256;
        const stableWrite = Boolean(last(a)?.postDataSha256) && last(a)?.postDataSha256 === last(b)?.postDataSha256;
        result.set(key, {
            key,
            method: last(a)?.method ?? last(b)?.method ?? null,
            path: last(a)?.path ?? last(b)?.path ?? null,
            occurrences: { gotavern: a.length, pinned: b.length },
            status: last(a)?.status ?? null,
            bodySha256: stableBody ? last(a).bodySha256 : null,
            bodyNondeterministic: Boolean(last(a)?.bodySha256) && !stableBody,
            postDataSha256: stableWrite ? last(a).postDataSha256 : null,
            postDataNondeterministic: Boolean(last(a)?.postDataSha256) && !stableWrite,
            postDataLength: last(a)?.postDataLength ?? null,
        });
    }
    return result;
};

const observedStable = (first, second) => {
    const a = JSON.stringify(first?.observed ?? null);
    const b = JSON.stringify(second?.observed ?? null);
    return { stable: a === b, value: first?.observed ?? null, secondValue: second?.observed ?? null };
};

const main = async () => {
    const [gotavernFirst, gotavernSecond, pinnedFirst, pinnedSecond] = await Promise.all([
        load(gotavernFirstPath), load(gotavernSecondPath), load(pinnedFirstPath), load(pinnedSecondPath),
    ]);
    const inventory = await parseInventory();
    const ids = [...new Set([
        ...interactionsById(gotavernFirst).keys(),
        ...interactionsById(pinnedFirst).keys(),
    ])];

    const rows = [];
    const unexpected = [];
    for (const id of ids) {
        const g1 = interactionsById(gotavernFirst).get(id) ?? null;
        const g2 = interactionsById(gotavernSecond).get(id) ?? null;
        const p1 = interactionsById(pinnedFirst).get(id) ?? null;
        const p2 = interactionsById(pinnedSecond).get(id) ?? null;
        const gotavernStatus = g1?.status ?? 'absent';
        const pinnedStatus = p1?.status ?? 'absent';
        const drivenOnBothLegs = gotavernStatus === 'driven' && pinnedStatus === 'driven';

        const gotavernRequests = legRequests(g1, g2);
        const pinnedRequests = legRequests(p1, p2);
        const domainPrefix = DOMAIN_PATH[id] ?? null;
        const allKeys = [...new Set([...gotavernRequests.keys(), ...pinnedRequests.keys()])].sort();
        const requestKeys = allKeys.filter(key => !domainPrefix || key.split(' ')[1]?.startsWith(domainPrefix) || citationFor(key.split(' ')[1] ?? ''));
        const ambientKeys = allKeys.filter(key => !requestKeys.includes(key));
        const requestRows = [];
        const differences = [];
        const cited = [];
        for (const key of requestKeys) {
            const left = gotavernRequests.get(key) ?? null;
            const right = pinnedRequests.get(key) ?? null;
            let classification;
            if (!left) classification = 'missing-on-gotavern';
            else if (!right) classification = 'extra-on-gotavern';
            else if (left.status !== right.status) classification = 'different-status';
            else if (left.bodySha256 && right.bodySha256 && left.bodySha256 !== right.bodySha256) classification = 'different-body';
            else if (left.postDataSha256 && right.postDataSha256 && left.postDataSha256 !== right.postDataSha256) classification = 'different-write-payload';
            else classification = 'equal';
            const routeStatus = inventory.get(key) ?? 'unknown';
            const citation = citationFor(key.split(' ')[1] ?? '');
            if (classification !== 'equal') {
                const reason = citation ?? `difference on a route the inventory classifies as ` + routeStatus + `; UNEXPLAINED, so it must not be promoted`;
                if (citation) cited.push({ key, classification, reason });
                else differences.push({ key, classification, routeStatus, reason });
            }
            requestRows.push({
                key,
                classification,
                routeStatus,
                cited: citation,
                gotavern: left ? { status: left.status, bodySha256: left.bodySha256, bodyNondeterministic: left.bodyNondeterministic, postDataSha256: left.postDataSha256, postDataNondeterministic: left.postDataNondeterministic, occurrences: left.occurrences.gotavern } : null,
                pinned: right ? { status: right.status, bodySha256: right.bodySha256, bodyNondeterministic: right.bodyNondeterministic, postDataSha256: right.postDataSha256, postDataNondeterministic: right.postDataNondeterministic, occurrences: right.occurrences.pinned } : null,
            });
        }

        const gotavernObserved = observedStable(g1, g2);
        const pinnedObserved = observedStable(p1, p2);
        const observedComparable = gotavernObserved.stable && pinnedObserved.stable;
        const observedEqual = observedComparable && JSON.stringify(gotavernObserved.value) === JSON.stringify(pinnedObserved.value);
        const observedClassification = !drivenOnBothLegs
            ? 'not-driven'
            : (!observedComparable ? 'nondeterministic' : (observedEqual ? 'equal' : 'different-observed'));

        const equal = drivenOnBothLegs && differences.length === 0 && observedClassification === 'equal';
        // Collect the write requests each leg issued inside the domain, so a drive that only read can
        // never be promoted.
        const writes = key => {
            const list = [];
            for (const report of key) {
                for (const request of report?.requests ?? []) {
                    if (!domainPrefix || !request.path.startsWith(domainPrefix)) continue;
                    if (isWriteRequest(request)) list.push(`${request.method} ${request.path}`);
                }
            }
            return [...new Set(list)].sort();
        };
        const gotavernWrites = writes([g1, g2]);
        const pinnedWrites = writes([p1, p2]);
        const writeDemonstrated = gotavernWrites.length > 0 && pinnedWrites.length > 0;
        if (drivenOnBothLegs && !equal) {
            unexpected.push({ id, differences: differences.map(entry => entry.key), observedClassification });
        }
        rows.push({
            id,
            gotavernStatus,
            pinnedStatus,
            drivenOnBothLegs,
            notDrivenReason: gotavernStatus === 'driven' ? (pinnedStatus === 'driven' ? null : p1?.reason ?? 'absent') : (g1?.reason ?? 'absent'),
            requestCount: requestRows.length,
            ambientRequestCount: ambientKeys.length,
            differences,
            citedDifferences: cited,
            observedClassification,
            observed: { gotavern: gotavernObserved.value, pinned: pinnedObserved.value },
            observedStablePerLeg: { gotavern: gotavernObserved.stable, pinned: pinnedObserved.stable },
            writeDemonstrated,
            writeRequests: { gotavern: gotavernWrites, pinned: pinnedWrites },
            requests: requestRows,
            promotable: equal && writeDemonstrated,
        });
    }

    const comparison = {
        schemaVersion: 1,
        question: 'after a write-then-read interaction in each data domain, does the browser observe the same requests, responses and final values on both legs?',
        inputs: { gotavernFirst: gotavernFirstPath, gotavernSecond: gotavernSecondPath, pinnedFirst: pinnedFirstPath, pinnedSecond: pinnedSecondPath },
        provenance: { gotavern: gotavernFirst.provenance, pinned: pinnedFirst.provenance },
        guards: {
            faithful: Boolean(gotavernFirst.reachedUserState?.settingsReady) && Boolean(pinnedFirst.reachedUserState?.settingsReady) && !gotavernFirst.failure && !pinnedFirst.failure,
            gotavernReachedUserState: Boolean(gotavernFirst.reachedUserState?.settingsReady),
            pinnedReachedUserState: Boolean(pinnedFirst.reachedUserState?.settingsReady),
            bothLegsCompletedDrive: !gotavernFirst.failure && !pinnedFirst.failure && !gotavernSecond.failure && !pinnedSecond.failure,
            observedStableAcrossTwoRunsPerLeg: rows.every(row => row.observedStablePerLeg.gotavern && row.observedStablePerLeg.pinned),
        },
        drivenOnBothLegs: rows.filter(row => row.drivenOnBothLegs).map(row => row.id),
        notDriven: rows.filter(row => !row.drivenOnBothLegs).map(row => ({ id: row.id, reason: row.notDrivenReason, gotavernStatus: row.gotavernStatus, pinnedStatus: row.pinnedStatus })),
        promotable: rows.filter(row => row.promotable).map(row => row.id),
        notPromotable: rows.filter(row => !row.promotable).map(row => row.id),
        unexpectedCount: unexpected.length,
        unexpected,
        comparisonNote: 'Requests are compared within each interaction\'s own domain path; ambient requests the frontend issues while a drive runs (rendering, background loading, polling) are counted separately because slice attribution depends on timing. Response bodies and write payloads are compared only where TWO RUNS OF EACH LEG agree on the digest. Differences on a documented boundary (the thumbnail codec) are cited, not counted as unexpected.',
        rows,
    };
    // Write the artifact from inside the script rather than through a shell redirect: PowerShell's
    // `>` writes UTF-16LE, which produces a comparison file that no JSON reader accepts.
    const outIndex = process.argv.indexOf('--out');
    if (outIndex !== -1) {
        await fs.writeFile(path.resolve(process.argv[outIndex + 1]), JSON.stringify(comparison, null, 2) + '\n', 'utf8');
    } else {
        console.log(JSON.stringify(comparison, null, 2));
    }
    if (unexpected.length > 0) {
        console.error(`data-domain comparison FAILED: ${unexpected.length} interaction(s) differ while driven on both legs: ${unexpected.map(entry => entry.id).join(', ')}`);
        process.exit(1);
    }
};

await main();
