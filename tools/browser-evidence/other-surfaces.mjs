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
        'galleryRenderedTheStagedTileOnBothLegs', 'galleryTileThumbnailPaintedOnBothLegs',
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

/**
/**
 * Q17 -- THE AUTHOR'S NOTE DEPTH SWEEP (GOAL.md Q17, docs/goal-scorecard.md).
 *
 * The claim this artefact makes is positional and byte-exact at once: for every case it drove, the note
 * landed where the PINNED leg put it -- same message index, same number of history turns above and below it,
 * same role -- AND the provider request was byte-identical between the subjects. The expected positions came
 * from a pinned-leg run of the same program (prepare-authors-note.mjs), never from a reading of the source.
 *
 * A check that is `null` was DELIBERATELY NOT MEASURED (the retired deeper-than-history class). It is not a
 * failure and not a pass: it must appear in `notMeasured`, and the artefact must carry `depthCoverage` saying
 * which depth classes are covered and which are out of scope, so a reader cannot mistake a gap for coverage.
 */
export function authorsNoteSurface(ctx, noteComparison) {
    if (!noteComparison) return;
    if (noteComparison.verdict !== 'PASS') {
        ctx.fail(`verdict is ${JSON.stringify(noteComparison.verdict)} (${noteComparison.failureReason ?? 'no reason recorded'}), so the committed artefact records a red run`);
    }
    if (noteComparison.measuredBy !== 'pinned-leg') {
        ctx.fail(`measuredBy is ${JSON.stringify(noteComparison.measuredBy)}: the expectation must come from a pinned-leg run, never from a derivation`);
    }
    const cases = Array.isArray(noteComparison.cases) ? noteComparison.cases : [];
    if (cases.length === 0) {
        ctx.fail('cases is empty: an artefact with no judged case supports no claim');
        return;
    }
    for (const entry of cases) {
        if (entry.verdict !== 'PASS') {
            ctx.fail(`case ${entry.caseId} is ${JSON.stringify(entry.verdict)}: ${entry.reason ?? 'no reason recorded'}`);
            continue;
        }
        // THE CLAIM, RE-READ FROM THE ARTEFACT RATHER THAN TRUSTED: a PASS must actually carry the equality
        // and the note's presence/absence story for its own case.
        const checks = entry.checks ?? {};
        for (const name of ['gotavernProducedARequest', 'pinnedProducedARequest', 'gotavernOverlayApplied', 'pinnedOverlayApplied', 'bodySha256Equal', 'bodyLengthEqual', 'layout.noteIndex', 'layout.historyBelow', 'allLayoutAndByteChecksPassed']) {
            if (checks[name] !== true) {
                ctx.fail(`case ${entry.caseId} is PASS but checks.${name} is ${JSON.stringify(checks[name])}`);
            }
        }
        // AN EMPTY CAPTURE MUST NEVER READ AS A COMPARISON (the phase guard, restated at the artefact level).
        const details = entry.details ?? {};
        if (!details.pinnedLeg && !details.pinnedExpectation) {
            ctx.fail(`case ${entry.caseId} is PASS but records no pinned observation, so nothing was compared`);
        }
    }
    // THE REQUIRED AXES ARE PRESENT, named rather than assumed: depth 0, a non-zero depth, and the disabled
    // switch. A sweep that silently lost one of them would still report PASS over the rest.
    const byId = Object.fromEntries(cases.map(entry => [entry.caseId, entry]));
    for (const required of ['parity', 'depth0', 'disabled-interval0']) {
        if (!byId[required]) ctx.fail(`case ${required} is absent, so a required Q17 axis was not driven`);
    }
    if (!cases.some(entry => entry.case?.enabled === false)) ctx.fail('no case records enabled: false, so the disabled switch was not driven');
    if (!cases.some(entry => entry.case?.depth === 0)) ctx.fail('no case records depth 0, so the newest position was not driven');
    if (!cases.some(entry => Number(entry.case?.depth) > 0 && entry.case?.position === 'IN_CHAT')) ctx.fail('no IN_CHAT case with a non-zero depth was driven');
    // THE STATED GAP MUST BE STATED. `notMeasured` and `depthCoverage` are what keep a retired class visible.
    if (!Array.isArray(noteComparison.notMeasured)) {
        ctx.fail('notMeasured is absent: a deliberately unmeasured check must be recorded, not omitted');
    }
    const coverage = noteComparison.depthCoverage ?? {};
    if (!('pastHistoryInsideBudget' in coverage)) {
        ctx.fail('depthCoverage.pastHistoryInsideBudget is absent: the artefact must say whether a depth past the history but inside the budget was measured, and `null` means it was not');
    }
    if (!coverage.pastBudgetOutOfScope?.rule) {
        ctx.fail('depthCoverage.pastBudgetOutOfScope.rule is absent: the artefact must state that depth past the budget is a truncation fact rather than a depth fact');
    }
    // THE SWEEP MUST HAVE BEEN DISCRIMINATING: distinct cases, distinct requests.
    if (noteComparison.sweep?.theCapturesDiffer !== true) {
        ctx.fail(`sweep.theCapturesDiffer is ${JSON.stringify(noteComparison.sweep?.theCapturesDiffer)}: cases that produce one identical request are one case wearing several names (AGENTS.md 50)`);
    }
    // A simulated provider must never be sold as a production claim (rule 22).
    ctx.observe(`Q17 covers ${cases.length} case(s); pastHistoryInsideBudget=${JSON.stringify(coverage.pastHistoryInsideBudget)} (null = not measured, declared in notMeasured)`);
}

/**
 * helper-variables-comparison.json: the 酒馆助手 VARIABLE surface (GOAL.md Q10; AGENTS.md 47-50).
 *
 * THIS ONE IS STRICTER THAN ITS SIBLINGS ON PURPOSE. The claim it makes is the one GOAL.md section 3 makes -- a
 * variable changes the FINAL provider request -- and the failure mode this repository has shipped before is a green
 * that proved the weaker thing ("it persisted to the chat file"). So every guard here is REQUIRED, with no unproven[]
 * escape hatch for any of them: a subject that cannot show the value on the wire, or cannot show it on disk, has not
 * demonstrated the claim and must not be allowed to declare its way past it.
 *
 * TWO VEHICLES, ONE CLAIM, ONE ARTEFACT. `vehicle` says which drove this recording, and the required guard set is
 * per-vehicle because each can only assert what it exercises:
 *   NARROW (primary)  one variable, one prompt reading it through the host macro engine, one generateRaw per case.
 *                     Compare scopes and the nested read belong to the OTHER vehicle -- asserting them here would be
 *                     requiring a guard this vehicle never computes, which reads as red rather than as not-applicable.
 *   UI (second)        the full preset/card/chat-select vehicle. It was attempted FIRST and cost four reds, all in
 *                     the vehicle; it is kept for the `preset` scope, which needs a preset to exist at all.
 * A recording whose `vehicle` is unrecognised FAILS rather than falling through to a default set, so a future vehicle
 * cannot inherit these assertions by accident.
 */
const VARIABLE_GUARD_SETS = {
    narrow: [
        'legsPresent', 'driveCompleted', 'sameApiSurface', 'offIsTheControl',
        'valueOnWire', 'macroWasTheResolver', 'changeChangesTheWire', 'deleteReturnsToEmptyForm',
        'globalScopeReachesWire', 'messageStoredNotSurfaced',
        'survivesFreshPage', 'survivesRestart',
        'nodeEqualsGo',
    ],
    ui: [
        'legsPresent', 'driveCompleted', 'sameApiSurface', 'offIsTheControl',
        'valueOnWire', 'changeChangesTheWire', 'deleteReturnsToParent',
        'valueOnDisk', 'globalOnDisk', 'characterOnDisk', 'survivesFreshPage', 'survivesRestart',
        'globalScopeReachesWire', 'characterScopeReachesWire', 'nestedValueResolves',
        'chatScopeIsolated', 'globalScopeNotChatScoped',
        'messageStoredNotSurfaced',
        'injectionPlaced', 'injectionRemoved',
        'nodeEqualsGo',
    ],
};

export function helperVariablesSurface(ctx, variableComparison) {
    if (!variableComparison) return;
    const guards = variableComparison.guards ?? {};
    const vehicle = /^narrow/.test(String(variableComparison.vehicle ?? '')) ? 'narrow'
        : /^ui-select|^UI/.test(String(variableComparison.vehicle ?? '')) || variableComparison.surface?.includes('injection') ? 'ui'
        : null;
    if (vehicle === null) {
        ctx.fail(`names no recognised vehicle (${JSON.stringify(variableComparison.vehicle ?? null)}), so this check cannot say which guards the claim requires -- the artefact must declare it`);
        return;
    }
    ctx.observe(`vehicle: ${vehicle} (${VARIABLE_GUARD_SETS[vehicle].length} required guards)`);
    const required = VARIABLE_GUARD_SETS[vehicle];
    for (const guard of required) {
        if (guards[guard] !== true) {
            ctx.fail(`guards.${guard} is ${JSON.stringify(guards[guard])}, so the artefact does not support the claim that a 酒馆助手 variable changes the final provider request AND survives on disk identically on both subjects`);
        }
    }
    for (const asymmetry of variableComparison.asymmetries ?? []) {
        ctx.fail(`asymmetries names ${asymmetry.guard} (gotavern=${JSON.stringify(asymmetry.gotavern)}, pinned=${JSON.stringify(asymmetry.pinned)}): a guard true on one subject and false on the other is the difference this comparison exists to find`);
    }
    if ((variableComparison.mismatches ?? []).length > 0) {
        ctx.fail(`mismatches names ${variableComparison.mismatches.map(item => `${item.case}.${item.field}`).join(', ')}, so the provider request differs between the subjects`);
    }
    if (Array.isArray(variableComparison.failedGuards) && variableComparison.failedGuards.length > 0) {
        ctx.fail(`failedGuards names ${variableComparison.failedGuards.join(', ')}`);
    }
    if (Array.isArray(variableComparison.driveStepFailures) && variableComparison.driveStepFailures.length > 0) {
        ctx.fail(`driveStepFailures names ${variableComparison.driveStepFailures.join('; ')}: a drive step that did not happen makes every later guard unattributable (rule 10)`);
    }
    // AN ARTEFACT THAT SAYS A GUARD IS UNPROVEN IS SAYING IT CANNOT SUPPORT THE CLAIM, and every guard above is
    // required -- so a declaration here is a contradiction rather than an excusal. This is the opposite of
    // helperSurface's rule and is deliberate: that surface legitimately cannot judge some things, this one can.
    const declared = new Set(variableComparison.declaredUnproven ?? []);
    for (const guard of required) {
        if (declared.has(guard)) {
            ctx.fail(`${guard} is required for this claim and is also declared unproven: the two cannot both be true`);
        }
    }
    // The pinned revision is part of the claim: the semantics were read from ONE commit, and a comparison against
    // another extension is a comparison of nothing.
    const pinnedCommit = variableComparison.apiSurface?.gotavern?.pinnedCommit ?? null;
    if (pinnedCommit !== '837a6288135cde61522a9279173b98020f08807e') {
        ctx.fail(`apiSurface.gotavern.pinnedCommit is ${JSON.stringify(pinnedCommit)}, not the pinned N0VI028/JS-Slash-Runner commit`);
    }
    // The absences this artefact REPORTS instead of testing must actually have been measured, or the row saying
    // "there is no setVariables / no quiet option" is a claim about a file nobody read.
    const absent = variableComparison.apiSurface?.gotavern?.absentConfirmed ?? [];
    for (const name of ['setVariables', 'quiet option']) {
        if (!absent.includes(name)) {
            ctx.fail(`apiSurface.gotavern.absentConfirmed does not record ${JSON.stringify(name)}, so the artefact's statement that it does not exist at the pinned commit was not measured`);
        }
    }
    // Rule 22, as for the generation surface: a simulated peer is not a production claim.
    const unproven = (variableComparison.unproven ?? []).join(' ');
    if (!/real provider/i.test(unproven)) {
        ctx.fail('unproven[] does not name the real-provider limitation: rule 22 makes a simulated peer unverified for production, and the artefact must say it');
    }
    ctx.observations.push(`both halves required and green: wire + disk, ${required.length} guards, 0 declarable`);
}
