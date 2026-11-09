// extension-corpus-netquiet.mjs -- classify a leg's page network as SAME-ORIGIN (the subject's own routes)
// versus EXTERNAL EGRESS (third-party hosts the page's extension code reaches), and decide the drive guard
// from the former while ASSERTING the latter against a declared origin set.
//
// WHY THIS EXISTS (measured 2026-11-08, runs `Third-party extension compatibility` 42478967874 and
// `GoTavern published-extension smoke` 42477517830): a third-party extension's client code issued
// `GET https://api.github.com/repos/DangerDaza/Dooms-Enhancement-Suite` on page load. On the two failing
// runs that request did not settle within the driver's 120 s window, and `network-quiet` -- which counted
// EVERY page request -- failed the whole leg. The pinned oracle leg failed the SAME guard with the SAME
// unresolved path and the SAME 796 recorded requests in run 42477517830, which is what makes this a
// DRIVER defect rather than a product finding: a request the subject server does not emit cannot be a
// statement about the subject.
//
// WHAT CHANGED, AND WHAT DID NOT. The drive guard now watches the SUBJECT's own origin, so a hung
// same-origin request still fails the leg by name. External egress is not ignored: every origin is
// counted, the approved set is a DECLARED list with the evidence that produced it, and an origin outside
// that set fails the leg by name (`unexpected-external-origin`). A stalled DECLARED origin is recorded,
// not failed, because its timing is the runner's network weather.
//
// THE APPROVED SET IS MEASURED, NOT ASSUMED. Entry 1 was recorded by a single-extension leg
// (`extension-corpus-probe.mjs` on GoTavern, 2026-11-08, Dooms-Enhancement-Suite at the lock's pinned
// commit 893b1e17f00f63f08de913777063b61e8d424882): `externalEgress.origins["https://api.github.com"] =
// {requests:1, pending:0, p50LatencyMs:2939}`. It is also the origin whose path shape appears unresolved
// in the two red runs. A future extension that reaches a new host changes the observed set and fails
// until someone records that host with its evidence -- which is the point.

/**
 * THE DECLARED EXTERNAL ORIGINS a page may reach during this corpus drive. `capability`/`extension` name
 * which pinned corpus entry emits it, so the declaration is auditable against the lock rather than being
 * a bare allowlist.
 */
export const APPROVED_EXTERNAL_ORIGINS = [
    {
        origin: 'https://api.github.com',
        extension: 'Dooms-Enhancement-Suite',
        pinnedCommit: '893b1e17f00f63f08de913777063b61e8d424882',
        reason: 'the extension\'s client code performs a GitHub REST update check on page load; it is page-side egress, not a subject-server request',
        evidence: 'measured 2026-11-08 by a single-extension leg: externalEgress.origins["https://api.github.com"]={requests:1,pending:0,p50LatencyMs:2939}; the same path shape (/repos/DangerDaza/Dooms-Enhancement-Suite) was the unresolved request in runs 42478967874 and 42477517830, where BOTH subjects failed identically',
    },
];

const approvedOrigins = new Set(APPROVED_EXTERNAL_ORIGINS.map(entry => entry.origin));

/** The entries that belong to the SUBJECT (its own origin), in recorded order. */
export function sameOriginEntries(entries, subjectOrigin) {
    return (entries ?? []).filter(entry => entry.sameOrigin === true || entry.origin === subjectOrigin);
}

/** The entries that left the subject's origin, in recorded order. */
export function externalEntries(entries, subjectOrigin) {
    return (entries ?? []).filter(entry => !(entry.sameOrigin === true || entry.origin === subjectOrigin));
}

/**
 * Wait, bounded, until every SAME-ORIGIN request has a response and no new same-origin request arrived for
 * `quietMs`. `unresolved` names the paths, so a red says what did not settle rather than that something did.
 */
export async function waitForNetworkQuiet(entries, { quietMs = 2500, deadlineMs = 45000, subjectOrigin } = {}) {
    const scoped = subjectOrigin === undefined ? entries : sameOriginEntries(entries, subjectOrigin);
    const started = Date.now();
    let lastCount = scoped.length;
    let lastChange = Date.now();
    while (Date.now() - started < deadlineMs) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const current = subjectOrigin === undefined ? entries : sameOriginEntries(entries, subjectOrigin);
        if (current.length !== lastCount) { lastCount = current.length; lastChange = Date.now(); }
        if (!current.some(entry => entry.status === null) && Date.now() - lastChange >= quietMs) {
            return { quiet: true, waitedMs: Date.now() - started, requests: current.length, scope: subjectOrigin === undefined ? 'all' : 'same-origin' };
        }
    }
    const current = subjectOrigin === undefined ? entries : sameOriginEntries(entries, subjectOrigin);
    return {
        quiet: false,
        waitedMs: Date.now() - started,
        requests: current.length,
        scope: subjectOrigin === undefined ? 'all' : 'same-origin',
        unresolved: current.filter(entry => entry.status === null).map(entry => entry.path).slice(0, 10),
    };
}

/**
 * Summarise the page's external egress per origin and classify it against the DECLARED set. `unexpected`
 * is the guard: an origin nobody recorded is a harness-faithfulness failure that must fail by name.
 */
export function classifyExternalEgress(entries, subjectOrigin) {
    const byOrigin = {};
    for (const entry of externalEntries(entries, subjectOrigin)) {
        const record = byOrigin[entry.origin] ?? {
            origin: entry.origin,
            approved: approvedOrigins.has(entry.origin),
            requests: 0,
            pending: 0,
            unresolved: [],
            latencies: [],
        };
        record.requests += 1;
        if (entry.status === null) {
            record.pending += 1;
            if (record.unresolved.length < 10) record.unresolved.push(entry.path.split('?')[0]);
        }
        if (typeof entry.latencyMs === 'number') record.latencies.push(entry.latencyMs);
        byOrigin[entry.origin] = record;
    }
    for (const record of Object.values(byOrigin)) {
        record.latencies.sort((left, right) => left - right);
        record.p50LatencyMs = record.latencies.length ? record.latencies[Math.floor(record.latencies.length * 0.5)] : null;
        delete record.latencies;
    }
    const unexpected = Object.values(byOrigin).filter(record => record.approved !== true).map(record => record.origin);
    return {
        subjectOrigin,
        origins: byOrigin,
        originCount: Object.keys(byOrigin).length,
        pending: Object.values(byOrigin).reduce((sum, record) => sum + record.pending, 0),
        approvedOrigins: [...approvedOrigins].sort(),
        unexpected,
    };
}

/**
 * The whole settle decision for one leg phase: same-origin quiet is the DRIVE guard; external egress is
 * classified against the declared set and its unexpected origins are a NAMED failure.
 */
export async function settleWithEgressClassification(entries, { subjectOrigin, quietMs = 2500, deadlineMs = 120000 } = {}) {
    const quiet = await waitForNetworkQuiet(entries, { quietMs, deadlineMs, subjectOrigin });
    const external = classifyExternalEgress(entries, subjectOrigin);
    return {
        quiet,
        external,
        // A same-origin hang is a drive failure; an unexpected external origin is a declared-set failure.
        ok: quiet.quiet === true && external.unexpected.length === 0,
        failed: [
            ...(quiet.quiet === true ? [] : ['network-quiet']),
            ...(external.unexpected.length === 0 ? [] : ['unexpected-external-origin']),
        ],
    };
}
