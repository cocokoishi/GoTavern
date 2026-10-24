// THE NON-CHAT-COMPLETION BROWSER SURFACES: startup, data domain, extension pairs.
//
// These are unchanged in substance -- this file is the same checks the verifier already ran, moved out
// so the chat-completion invariants can be read on their own. They are a different KIND of artefact (row
// sets with reasons, not two-leg drives), and mixing the two in one function is how the original file
// grew to 1200 lines.

const requireReason = (ctx, where, entry) => {
    const reason = entry?.knownReason;
    if (typeof reason !== 'string' || reason.trim() === '') {
        ctx.fail(`${where} records a divergence with no knownReason: ${JSON.stringify(entry).slice(0, 300)}`);
    }
};

/** startup-comparison.json: every row classified, every divergence explained, the guards faithful. */
export function startupSurface(ctx, startup) {
    if (!startup) return;
    if (startup.unexpectedCount !== 0) {
        ctx.fail(`unexpectedCount is ${startup.unexpectedCount}, must be 0`);
    }
    if (Array.isArray(startup.unexpected) && startup.unexpected.length !== 0) {
        ctx.fail(`unexpected[] holds ${startup.unexpected.length} entr(ies)`);
    }
    for (const guard of ['faithful', 'gotavernReachedUserState', 'pinnedReachedUserState']) {
        if (startup.guards?.[guard] !== true) {
            ctx.fail(`guards.${guard} is ${JSON.stringify(startup.guards?.[guard])}, must be true`);
        }
    }
    const rows = Array.isArray(startup.rows) ? startup.rows : [];
    if (rows.length === 0) {
        ctx.fail('rows[] is empty, so the comparison compared nothing');
    }
    for (const row of rows) {
        if (row.classification === 'equal') continue;
        requireReason(ctx, `${row.method} ${row.path}`, row);
        if (row.needsAttention === true && row.unexpected !== false) {
            ctx.fail(`${row.method} ${row.path} needsAttention without being classified unexpected:false`);
        }
    }
    ctx.observe(`${rows.length} rows, unexpectedCount 0, guards faithful`);
}

/**
 * data-domain-comparison.json: a promoted cell must have demonstrated a WRITE on both legs, because a
 * drive that only reads cannot fail on a difference.
 */
export function dataDomainSurface(ctx, dataDomain) {
    if (!dataDomain) return;
    if (dataDomain.unexpectedCount !== 0) {
        ctx.fail(`unexpectedCount is ${dataDomain.unexpectedCount}, must be 0`);
    }
    if (Array.isArray(dataDomain.unexpected) && dataDomain.unexpected.length !== 0) {
        ctx.fail(`unexpected[] holds ${dataDomain.unexpected.length} entr(ies)`);
    }
    for (const guard of ['faithful', 'gotavernReachedUserState', 'pinnedReachedUserState', 'bothLegsCompletedDrive', 'observedStableAcrossTwoRunsPerLeg']) {
        if (dataDomain.guards?.[guard] !== true) {
            ctx.fail(`guards.${guard} is ${JSON.stringify(dataDomain.guards?.[guard])}, must be true`);
        }
    }
    const rows = Array.isArray(dataDomain.rows) ? dataDomain.rows : [];
    if (rows.length === 0) {
        ctx.fail('rows[] is empty, so no domain was compared');
    }
    let promoted = 0;
    for (const row of rows) {
        if (row.promotable !== true) continue;
        promoted += 1;
        if (row.writeDemonstrated !== true) {
            ctx.fail(`${row.domain}: promotable without writeDemonstrated -- a read-only drive cannot fail on a difference`);
        }
    }
    const claimed = Array.isArray(dataDomain.promotable) ? dataDomain.promotable.length : 0;
    if (claimed !== promoted) {
        ctx.fail(`promotable[] lists ${claimed} domains but ${promoted} row(s) are promotable`);
    }
    ctx.observe(`${rows.length} rows, ${claimed} promoted domain(s), unexpectedCount ${dataDomain.unexpectedCount}`);
}

/**
 * extension-{tavern-helper,littlewhitebox}-comparison.json: the only artefacts whose claim is about a
 * frontend extension loading on a release-shaped install.
 */
export function extensionSurface(ctx, label, extensionComparison) {
    if (!extensionComparison) return;
    for (const guard of ['faithful', 'gotavernReachedUserState', 'pinnedReachedUserState', 'gotavernExtensionLoaded', 'pinnedExtensionLoaded', 'extensionRevisionMatches', 'startingStateMatches', 'configMatches']) {
        if (extensionComparison.guards?.[guard] !== true) {
            ctx.fail(`guards.${guard} is ${JSON.stringify(extensionComparison.guards?.[guard])}, so the pair does not support a claim`);
        }
    }
    if (!Array.isArray(extensionComparison.rows) || extensionComparison.rows.length === 0) {
        ctx.fail('has no rows');
    }
    for (const row of extensionComparison.rows ?? []) {
        if (row.classification !== 'equal') requireReason(ctx, `${row.method} ${row.path}`, row);
    }
    // A path difference without a reason is the reason-less divergence this gate exists to reject, and a
    // reason that does not name a mechanism is the same shape.
    for (const difference of extensionComparison.pathDifferences ?? []) {
        requireReason(ctx, `pathDifferences ${difference.path}`, difference);
        const reason = difference.knownReason ?? '';
        const namesMechanism = reason.includes('Jimp') || (reason.includes('drive') && reason.includes('network-quiet'));
        if (!namesMechanism) {
            ctx.fail(`pathDifferences ${difference.path} has a reason that names no mechanism: ${JSON.stringify(reason)}`);
        }
    }
    // Both drives must have ended on the page's own quiet signal.
    for (const leg of ['gotavern', 'pinned']) {
        if (extensionComparison.captureQuiet?.[leg]?.quiet !== true) {
            ctx.fail(`captureQuiet.${leg} is ${JSON.stringify(extensionComparison.captureQuiet?.[leg])}; a drive that ended without network quiet cannot be compared`);
        }
        if (Array.isArray(extensionComparison.captureQuiet?.[leg]?.unresolved) && extensionComparison.captureQuiet[leg].unresolved.length > 0) {
            ctx.fail(`captureQuiet.${leg} ended with unresolved requests: ${JSON.stringify(extensionComparison.captureQuiet[leg].unresolved)}`);
        }
    }
    // The extension's written user data: a `shape` field must not be recorded without a reason.
    if (extensionComparison.userFiles?.shape?.length) {
        for (const key of extensionComparison.userFiles.shape) {
            const reason = extensionComparison.userFiles.shapeReason?.[key];
            if (typeof reason !== 'string' || reason.trim() === '') {
                ctx.fail(`userFiles.shape.${key} is classified shape with no reason`);
            }
        }
        if (extensionComparison.userFiles.matches !== true) {
            ctx.fail('userFiles entries differ in presence, size or JSON skeleton between the legs');
        }
    } else if (!Array.isArray(extensionComparison.userFiles?.entries) || extensionComparison.userFiles.entries.length === 0) {
        if (typeof extensionComparison.userFiles?.note !== 'string' || extensionComparison.userFiles.note.trim() === '') {
            ctx.fail('userFiles records no entries and no note saying so');
        }
    }
    if (extensionComparison.rows) {
        ctx.observe(`${extensionComparison.rows.length} rows, ${(extensionComparison.pathDifferences ?? []).length} non-row path difference(s), guards faithful`);
    }
}
