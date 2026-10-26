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

/**
 * asset-comparison.json: the browser-displayed asset surface (GOAL.md §8.4, AGENTS.md 42-46).
 *
 * WHY THIS CHECK IS STRICTER THAN ITS NEIGHBOURS. The artefact this one replaces recorded the exact defect
 * that a user reported -- `/thumbnail` 404 on GoTavern -- and reported `differenceCount: 0` because a
 * `knownReason` excused it. So: a divergence may describe BYTES and nothing else, it must name a mechanism,
 * and the guards that prove the page rendered must all be true. There is no acceptable status divergence
 * here, and no allowlist, because a browser-required asset that does not arrive IS the defect.
 */
export function assetSurface(ctx, assetComparison) {
    if (!assetComparison) return;
    const guards = assetComparison.guards ?? {};
    const required = [
        // faithfulness first: a leg that requested nothing or rendered nothing cannot support a claim
        'bothLegsRecordedImageRequests', 'bothLegsRequestedAThumbnail', 'bothLegsRenderedTheCharacterList',
        'bothLegsOpenedAChat', 'sameFixture',
        // the user's own questions
        'noImageRequestFailedOnEitherLeg', 'everyCharacterListAvatarDecoded', 'everyMessageAvatarDecoded',
        'backgroundAppliedOnBothLegs', 'backgroundServedWithBytesOnBothLegs', 'stagedBackgroundServedWithBytesOnBothLegs',
        // THE THREE SURFACES THAT WERE UNPROVEN UNTIL THEY WERE DRIVEN (Q5/Q6/Q7's missing halves). They are
        // REQUIRED here, not merely recorded: the artefact used to list them in `unproven[]`, and a required-list
        // entry is what turns "driven" into "cannot silently regress to unproven".
        'galleryRenderedTheStagedTileOnBothLegs', 'galleryTileThumbnailPaintedOnBothLegs', 'stagedBackgroundPaintedOnBothLegs',
        'personaPickerRenderedOnBothLegs', 'personaPickerRowIsClickable', 'personaPickerRowImageDecodedOnBothLegs', 'personaPickerSelectedOnBothLegs',
        'personaPickerClickedANonCurrentRow', 'personaPickerChangedThePersonaOnBothLegs',
        'swipeChangedTheMessageOnBothLegs', 'swipedMessageAvatarDecodedOnBothLegs',
        // AND THE REAL CARD IS IN PLAY (AGENTS.md 56: a leg that needs a real artifact uses the committed
        // derivation). A leg that silently ran on the synthetic card alone would report the same green.
        'bothLegsStagedTheRealCard', 'realCardStructureEqualOnBothLegs',
        // cross-leg
        'sameImageUrlSet', 'perUrlStatusEqual', 'perUrlContentTypeEqual', 'nonThumbnailBytesEqual',
        'thumbnailResponsesAreImages', 'thumbnailDivergenceIsBytesOnly',
        // the browser's own complaints
        'noExtraConsoleLoadFailuresOnGotavern', 'noPageErrors', 'bothLegsCompleted',
    ];
    for (const guard of required) {
        if (guards[guard] !== true) {
            ctx.fail(`guards.${guard} is ${JSON.stringify(guards[guard])}, so the artefact does not support the claim that the page displays its images`);
        }
    }
    if (Array.isArray(assetComparison.failedGuards) && assetComparison.failedGuards.length > 0) {
        ctx.fail(`failedGuards names ${assetComparison.failedGuards.join(', ')}, so a committed artefact records a red run`);
    }
    for (const leg of ['gotavern', 'pinned']) {
        const entry = assetComparison.legs?.[leg];
        if (!entry) {
            ctx.fail(`legs.${leg} is missing`);
            continue;
        }
        if (!Array.isArray(entry.imageRequests) || entry.imageRequests.length === 0) {
            ctx.fail(`legs.${leg}.imageRequests is empty: the drive recorded no image at all, which is a harness-faithfulness alarm rather than a pass`);
            continue;
        }
        const failed = entry.imageRequests.filter(request => Number(request.status) >= 400);
        if (failed.length > 0) {
            ctx.fail(`legs.${leg} requested ${failed.length} image(s) that failed: ${failed.map(request => `${request.status} ${request.url}`).join(', ')}`);
        }
        const undecoded = (entry.characterList ?? []).filter(image => image.complete !== true || !(image.naturalWidth > 0));
        if (undecoded.length > 0) {
            ctx.fail(`legs.${leg} has ${undecoded.length} character-list avatar(s) that did not decode, e.g. ${JSON.stringify(undecoded[0]?.src)}`);
        }
        if ((entry.characterList ?? []).length === 0) {
            ctx.fail(`legs.${leg}.characterList is empty: the character list rendered no avatar, so nothing about avatars was measured`);
        }
        if (!entry.background?.url) {
            ctx.fail(`legs.${leg}.background applied no URL, so the background was never exercised`);
        }
    }
    // A DIVERGENCE MAY DESCRIBE BYTES ONLY, AND MUST NAME ITS MECHANISM.
    for (const divergence of assetComparison.divergences ?? []) {
        const reason = String(divergence.reason ?? '');
        if (divergence.kind !== 'codec') {
            ctx.fail(`divergence ${divergence.url} has kind ${JSON.stringify(divergence.kind)}: the only declared divergence on this surface is the thumbnail codec`);
        }
        if (reason.trim() === '') {
            ctx.fail(`divergence ${divergence.url} has no reason`);
        } else if (!/jimp/i.test(reason) || !/codec/i.test(reason)) {
            ctx.fail(`divergence ${divergence.url} has a reason that names no mechanism: ${JSON.stringify(reason)}`);
        }
        for (const field of ['status', 'contentType']) {
            if (divergence.gotavern?.[field] !== undefined || divergence.pinned?.[field] !== undefined) {
                ctx.fail(`divergence ${divergence.url} carries ${field}, which may never be excused by a declared divergence`);
            }
        }
    }
    // AND THE THING THAT SHIPPED MUST NOT BE EXCUSED: if a thumbnail answered non-200 on either leg, the
    // committed artefact is a bug report, not evidence (AGENTS.md 46).
    for (const leg of ['gotavern', 'pinned']) {
        for (const request of (assetComparison.legs?.[leg]?.imageRequests ?? []).filter(entry => entry.kind === 'thumbnail')) {
            if (Number(request.status) !== 200) {
                ctx.fail(`legs.${leg} thumbnail ${request.url} answered ${request.status}; a thumbnail the frontend requests must be 200 on both legs`);
            }
            if (!/^image\//i.test(String(request.contentType ?? ''))) {
                ctx.fail(`legs.${leg} thumbnail ${request.url} answered content-type ${JSON.stringify(request.contentType)}, which is not an image`);
            }
        }
    }
    // A GUARD THAT IS FALSE MUST BE DECLARED, OR THE ARTEFACT IS HIDING IT. This is the mechanism that lets a
    // known-unproven half live in the artefact honestly: `unproven[]` has to NAME the guard, so a false guard
    // cannot pass by being omitted from the required list (which is exactly how a `knownReason` allowlist turns
    // a red surface green, gate-blindspots §1).
    for (const [guard, value] of Object.entries(guards)) {
        if (value === true) continue;
        const declared = (assetComparison.unproven ?? []).some(entry => String(entry).startsWith(guard));
        if (!declared) {
            ctx.fail(`guards.${guard} is false and unproven[] does not name it: an undeclared failure is a finding, not a known gap`);
        }
    }
    ctx.observe(`${assetComparison.legs?.gotavern?.imageRequests?.length ?? 0} gotavern / ${assetComparison.legs?.pinned?.imageRequests?.length ?? 0} pinned image request(s), ${(assetComparison.divergences ?? []).length} declared divergence(s), all display guards true`);
}


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


/**
 * helper-comparison.json: the 酒馆助手 RENDER/VARIABLE surface (AGENTS.md 47, GOAL.md Q8 + Q10).
 *
 * THE CLAIM THIS ARTEFACT MAKES IS BOUNDED ON PURPOSE, so the check is too. Two kinds of guard:
 *   - guards true on both subjects, which must be true here: the iframe architecture, the 25 host imports,
 *     the module completion marker, the fixture, the negative control, and the on/off discrimination.
 *   - guards FALSE on both subjects, which are a DRIVER LIMITATION (rule 10) and may only be excused when
 *     the artefact names them in unproven[] with a mechanism. An excusal is not a pass: the guard stays out
 *     of the required set, unproven[] carries it, and a guard that is true on one subject and false on the
 *     other can never be excused (it lands in asymmetries[], which this check refuses).
 * A DECLARATION THAT HAS GONE STALE IS ALSO REFUSED: if a name in declaredUnproven is now true, the
 * excusal is hiding a green guard from the required set, so the artefact no longer says what it claims.
 */
export function helperSurface(ctx, helperComparison) {
    if (!helperComparison) return;
    const guards = helperComparison.guards ?? {};
    const required = [
        // the driver reached the state a user reaches, before any claim is read
        'legsPresent', 'driveCompleted', 'sameFixture', 'fixturesMatchEachOther',
        // Q8: the architecture the extension depends on, measured on both subjects
        'hostModulesServed', 'scriptIframeUnsandboxed', 'moduleCompleted',
        // rule 50: the pair can see the helper at all
        'helperSeenOnlyWhenOn',
        // the persistence guard's teeth, without which a green variablePersisted means nothing
        'negativeControlBites',
    ];
    for (const guard of required) {
        if (guards[guard] !== true) {
            ctx.fail(`guards.${guard} is ${JSON.stringify(guards[guard])}, so the artefact does not support the claim that the pinned 酒馆助手 iframe ran identically on both subjects`);
        }
    }
    for (const asymmetry of helperComparison.asymmetries ?? []) {
        ctx.fail(`asymmetries names ${asymmetry.guard} (gotavern=${JSON.stringify(asymmetry.gotavern)}, pinned=${JSON.stringify(asymmetry.pinned)}): a guard true on one subject and false on the other is the difference this comparison exists to find`);
    }
    if (Array.isArray(helperComparison.failedGuards) && helperComparison.failedGuards.length > 0) {
        ctx.fail(`failedGuards names ${helperComparison.failedGuards.join(', ')}, so a committed artefact records a red run`);
    }
    const declared = new Set(helperComparison.declaredUnproven ?? []);
    const unproven = helperComparison.unproven ?? [];
    for (const [name, value] of Object.entries(guards)) {
        if (value === true) {
            if (declared.has(name)) {
                ctx.fail(`${name} is declared unproven but is TRUE: the declaration is stale and is hiding a green guard from the required set`);
            }
            continue;
        }
        if (!declared.has(name)) {
            ctx.fail(`guards.${name} is ${JSON.stringify(value)} on both subjects and is NOT declared in unproven[], so this is an undeclared gap rather than a named driver limitation`);
            continue;
        }
        const entry = unproven.find(item => String(item).startsWith(`${name}:`));
        if (!entry || String(entry).length < 40) {
            ctx.fail(`${name} is declared unproven with no mechanism: unproven[] must carry "${name}: <why this cannot be judged on either subject>"`);
        }
    }
    ctx.observations.push(`declared unproven: ${[...declared].sort().join(', ') || '(none)'}`);
}

/**
 * helper-generation-comparison.json: the 酒馆助手 GENERATION surface (AGENTS.md 47/48/49/50, GOAL.md Q9/Q11).
 *
 * Every guard here must be true: this artefact's claim is that a helper script's generateRaw/generate
 * reached a model backend and produced the SAME request bytes on both subjects. There is nothing to
 * excuse -- a missing request, a different body or a non-discriminating pair is the finding.
 */
export function helperGenerationSurface(ctx, generationComparison) {
    if (!generationComparison) return;
    const guards = generationComparison.guards ?? {};
    const required = [
        'legsPresent', 'driveCompleted',
        'peerReached', 'connectionFromPeer', 'orderedPrompts', 'injectionVisible',
        // the byte claim and the rule-50 claim
        'nodeEqualsGo', 'helperSeenOnlyWhenOn',
    ];
    for (const guard of required) {
        if (guards[guard] !== true) {
            ctx.fail(`guards.${guard} is ${JSON.stringify(guards[guard])}, so the artefact does not support the claim that 酒馆助手's generation request equals pinned Node's`);
        }
    }
    for (const asymmetry of generationComparison.asymmetries ?? []) {
        ctx.fail(`asymmetries names ${asymmetry.guard}: the two subjects disagree on a generation guard`);
    }
    if ((generationComparison.mismatches ?? []).length > 0) {
        ctx.fail(`mismatches names ${generationComparison.mismatches.map(item => item.field).join(', ')}, so the provider request differs between the subjects`);
    }
    if (Array.isArray(generationComparison.failedGuards) && generationComparison.failedGuards.length > 0) {
        ctx.fail(`failedGuards names ${generationComparison.failedGuards.join(', ')}`);
    }
    // A simulated peer must never be sold as a production claim (rule 22), so the artefact has to say so.
    const unproven = (generationComparison.unproven ?? []).join(' ');
    if (!/real provider/i.test(unproven)) {
        ctx.fail('unproven[] does not name the real-provider limitation: rule 22 makes a simulated peer unverified for production, and the artefact must say it');
    }
}
