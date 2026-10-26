#!/usr/bin/env node
// Compare the two asset legs and print `asset-comparison.json`.
//
// THE RULE THIS FILE EXISTS TO ENFORCE. The previous artefact for this surface recorded the `/thumbnail`
// 404 with a `knownReason` and reported `differenceCount: 0`. AGENTS.md 46 says a fixture that expects the
// absence of a browser-required asset is a bug report, so this comparator has NO allowlist for a status:
// a 4xx/5xx on an image request of either leg fails, whatever the reason. What IS allowed to differ is
// BYTES, and only on `/thumbnail`, where the pure-Go codec cannot reproduce Jimp's output; that difference
// is recorded as a divergence with its reason and its sizes, never folded into "equal" and never used to
// excuse a status.
//
// The guards are named so a failure is a finding: `boundaryBindsOnThePinnedLeg`-style names, not
// `differenceCount`. Every guard also has a faithfulness counterpart (`bothLegsRecordedImageRequests`,
// `bothLegsRenderedTheCharacterList`) because a leg that requested nothing would otherwise pass every
// comparison it is absent from (AGENTS.md differential doctrine 7, gate-blindspots §2).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function compare({ gotavern, pinned }) {
    const guards = {};
    const divergences = [];
    const findings = [];

    const legName = report => report?.subject ?? 'unknown';
    const images = report => (Array.isArray(report?.imageRequests) ? report.imageRequests : []);
    const dom = report => report?.dom ?? null;

    // ---- faithfulness -------------------------------------------------------------------------
    // NOTHING REQUESTED IS NOT A PASS. A page that made no image request either did not render or was
    // not loaded; both are harness alarms (doctrine 7 / rule 52's inverse).
    guards.bothLegsRecordedImageRequests = images(gotavern).length > 0 && images(pinned).length > 0;
    guards.bothLegsRequestedAThumbnail = images(gotavern).some(entry => entry.kind === 'thumbnail')
        && images(pinned).some(entry => entry.kind === 'thumbnail');
    guards.bothLegsRenderedTheCharacterList = Boolean(dom(gotavern)?.characterListPresent) && (dom(gotavern)?.characterListCount ?? 0) > 0
        && Boolean(dom(pinned)?.characterListPresent) && (dom(pinned)?.characterListCount ?? 0) > 0;
    guards.bothLegsOpenedAChat = (dom(gotavern)?.messageCount ?? 0) > 0 && (dom(pinned)?.messageCount ?? 0) > 0;
    guards.sameFixture = JSON.stringify(gotavern?.provenance?.fixture?.files ?? null) === JSON.stringify(pinned?.provenance?.fixture?.files ?? null)
        && (gotavern?.provenance?.fixture?.files ?? []).length > 0;
    if (!guards.sameFixture) {
        findings.push('the two legs did not stage the same fixture; the comparison below is between two different trees');
    }

    // ---- the picture must decode --------------------------------------------------------------
    const failedImages = {
        gotavern: images(gotavern).filter(entry => entry.status >= 400),
        pinned: images(pinned).filter(entry => entry.status >= 400),
    };
    // NO STATUS ALLOWLIST EXISTS HERE, DELIBERATELY. A rule that excuses a 404 for an image the browser
    // asked for is the rule that let this defect ship.
    guards.noImageRequestFailedOnEitherLeg = failedImages.gotavern.length === 0 && failedImages.pinned.length === 0;
    for (const leg of ['gotavern', 'pinned']) {
        for (const entry of failedImages[leg]) {
            findings.push(`${leg}: ${entry.status} for ${entry.pathAndQuery} (${entry.kind}) -- a browser-required asset that the page requested and did not get`);
        }
    }

    const decoded = report => (dom(report)?.characterList ?? []).every(image => image.complete === true && image.naturalWidth > 0);
    guards.everyCharacterListAvatarDecoded = decoded(gotavern) && decoded(pinned);
    for (const leg of ['gotavern', 'pinned']) {
        const report = leg === 'gotavern' ? gotavern : pinned;
        const broken = (dom(report)?.characterList ?? []).filter(image => image.complete !== true || !(image.naturalWidth > 0));
        for (const image of broken) {
            findings.push(`${leg}: character-list avatar did not decode: src=${JSON.stringify(image.src)} complete=${image.complete} naturalWidth=${image.naturalWidth}`);
        }
    }

    const messagesDecoded = report => (dom(report)?.messages ?? []).length > 0
        && (dom(report)?.messages ?? []).every(image => image.complete === true && image.naturalWidth > 0);
    guards.everyMessageAvatarDecoded = messagesDecoded(gotavern) && messagesDecoded(pinned);
    for (const leg of ['gotavern', 'pinned']) {
        const report = leg === 'gotavern' ? gotavern : pinned;
        for (const image of (dom(report)?.messages ?? []).filter(entry => entry.complete !== true || !(entry.naturalWidth > 0))) {
            findings.push(`${leg}: chat-message avatar did not decode: src=${JSON.stringify(image.src)} complete=${image.complete} naturalWidth=${image.naturalWidth}`);
        }
    }

    // THE BACKGROUND IS A CSS URL, so it is proven by joining the applied CSS value to a request that
    // answered with bytes. A `background-image: url(/backgrounds/x.png)` that 404s is the user-visible
    // "backgrounds are broken" and no status comparison of the ROUTE would see it.
    const backgroundOf = report => {
        const driven = dom(report)?.backgroundDriven ?? null;
        const applied = driven?.appliedBackgroundImage ?? dom(report)?.background?.computedBackgroundImage ?? null;
        const match = typeof applied === 'string' ? applied.match(/url\("?([^")]+)"?\)/) : null;
        const url = match ? match[1] : null;
        if (!url) return { url: null, served: null, driven };
        let requestPath = null;
        try {
            requestPath = new URL(url, 'http://leg.invalid').pathname;
        } catch {
            requestPath = url;
        }
        const served = images(report).find(entry => entry.path === requestPath) ?? null;
        return { url, requestPath, served, driven };
    };
    const backgrounds = { gotavern: backgroundOf(gotavern), pinned: backgroundOf(pinned) };
    guards.backgroundAppliedOnBothLegs = Boolean(backgrounds.gotavern.url) && Boolean(backgrounds.pinned.url);
    // AND THAT IT IS THE STAGED BACKGROUND, not the fresh tree's `/backgrounds/__transparent.png`. A guard of
    // its own, because "something is applied" must never stand in for the user's own image (gate-blindspots §1:
    // a weaker observation replacing the claim is how a broken surface reads as a pass).
    //
    // TWO HALVES, KEPT APART DELIBERATELY. The PAINT (the staged tile selected in the gallery, #bg1 carrying it)
    // is not driven: the panel opens and no `.bg_example[bgfile=...]` appears within 15 s, measured on both
    // legs. Rather than weaken the claim to "some background is applied", the ROUTE is asserted here and the
    // paint is recorded in `unproven` with the measured reason (AGENTS.md 45: a boundary must say what the user
    // does not get). `/backgrounds/<file>` is the URL backgrounds.js hands to #bg1.
    guards.stagedBackgroundServedWithBytesOnBothLegs = [gotavern, pinned].every(report => {
        const request = dom(report)?.stagedBackgroundRequest ?? null;
        return Boolean(request) && request.httpStatus === 200 && /^image\//i.test(String(request.contentType ?? '')) && (request.byteLength ?? 0) > 0;
    });
    guards.stagedBackgroundDrivenOnBothLegs = dom(gotavern)?.stagedBackgroundDriven === true && dom(pinned)?.stagedBackgroundDriven === true;

    // ---- THE GALLERY PAINT (Q7's missing half) --------------------------------------------------
    //
    // The claim that used to be unproven is not "a background is applied" (the fresh tree applies
    // `/backgrounds/__transparent.png`) but "the STAGED background is painted after a user selects it in the
    // gallery". The guards are separate because they fail for different reasons: a gallery that rendered nothing
    // is a catalogue or harness finding; a gallery whose tile thumbnail did not paint is a thumbnail finding; a
    // `#bg1` that kept `__transparent.png` is the paint finding.
    const galleryOf = report => dom(report)?.backgroundDriven?.gallery ?? null;
    // THE TEST IS THE WHOLE-DOMUMENT QUESTION, NOT A SLICE OF IT. Run 40307800425 rendered 24 tiles on BOTH legs
    // and the staged file WAS one of them (`tileBgFile` in the same object said so), but the guard looked for it in
    // a 12-entry `bgFiles` sample and reported "the gallery did not render the staged tile" on both legs. That is
    // AGENTS.md 11 (a bounded listing cannot support a claim of absence) applied to a DOM query, and the probe now
    // records `stagedTilePresent` from the untruncated DOM. The guard reads that field, and keeps `tiles > 0` so an
    // empty gallery is still its own finding.
    guards.galleryRenderedTheStagedTileOnBothLegs = ['gotavern', 'pinned'].every(leg => {
        const gallery = galleryOf(leg === 'gotavern' ? gotavern : pinned);
        return Boolean(gallery) && (gallery.tiles ?? 0) > 0 && gallery.stagedTilePresent === true;
    });
    for (const leg of ['gotavern', 'pinned']) {
        if (!guards.galleryRenderedTheStagedTileOnBothLegs) {
            findings.push(`${leg}: the backgrounds gallery did not render the staged tile: ${JSON.stringify(galleryOf(leg === 'gotavern' ? gotavern : pinned))}`);
        }
    }
    // A `url(…)` in the tile's computed style is the thumbnail painting; `none` is not.
    const tilePainted = leg => /url\(/.test(String((backgrounds[leg].driven ?? {}).tileThumbnailAfterLoad ?? ''));
    guards.galleryTileThumbnailPaintedOnBothLegs = tilePainted('gotavern') && tilePainted('pinned');
    guards.stagedBackgroundPaintedOnBothLegs = guards.stagedBackgroundDrivenOnBothLegs;

    // ---- THE PERSONA PICKER (Q6's missing half) --------------------------------------------------
    //
    // Not "the persona thumbnail request answers" (already asserted) but "the picker lists the persona, its row's
    // image decodes, and clicking the row selects it". A persona that does not exist in `power_user` never renders
    // a row, so the drive calls the frontend's own loader first; the row count and the selection state are what
    // make a no-op click a finding rather than a silence.
    const pickerOf = report => dom(report)?.personaPicker ?? null;
    guards.personaPickerRenderedOnBothLegs = ['gotavern', 'pinned'].every(leg => {
        const picker = pickerOf(leg === 'gotavern' ? gotavern : pinned);
        return picker?.status === 'observed' && (picker?.rowCount ?? 0) > 0;
    });
    // AND THE ROW MUST BE CLICKABLE. Run 40314670847 measured `rowBox: {width:0,height:0}` with
    // `drawerIsOpen:false` on BOTH legs -- the drive had toggled the panel closed -- so the click could not reach
    // anything and the failure read like a product one. A row with no box is a DRIVE state, not a product claim,
    // and it is a guard of its own so it can never be folded into "the picker did not select".
    guards.personaPickerRowIsClickable = ['gotavern', 'pinned'].every(leg => {
        const picker = pickerOf(leg === 'gotavern' ? gotavern : pinned);
        return picker?.preconditions?.rowVisible === true
            && (picker?.preconditions?.rowBox?.width ?? 0) > 0
            && (picker?.preconditions?.rowBox?.height ?? 0) > 0;
    });
    guards.personaPickerRowImageDecodedOnBothLegs = ['gotavern', 'pinned'].every(leg => {
        const picker = pickerOf(leg === 'gotavern' ? gotavern : pinned);
        return picker?.rowImage?.settled === 'loaded' && (picker?.rowImage?.naturalWidth ?? 0) > 0;
    });
    guards.personaPickerSelectedOnBothLegs = ['gotavern', 'pinned'].every(leg => pickerOf(leg === 'gotavern' ? gotavern : pinned)?.selectedAfterClick === true);
    // THE CLICK MUST HAVE TARGETED A ROW THE SUBJECT WOULD ACT ON. `setUserAvatar` returns early when the clicked
    // persona is already `user_avatar` (personas.js:154-159), so a click on the current row is a no-op BY DESIGN:
    // run 40307800425 clicked the default persona and reported `selectedAfterClick:false` identically on both legs,
    // which is a harness-faithfulness alarm (rule 10), not a product finding. The precondition comes from the
    // subject's own model field (`personas.user_avatar`), read before the click, so it is asserted, not assumed.
    guards.personaPickerClickedANonCurrentRow = ['gotavern', 'pinned'].every(leg => pickerOf(leg === 'gotavern' ? gotavern : pinned)?.clickedWasCurrentBefore === false);
    // AND THE PICKER CHANGED THE PERSONA. `personaChanged` is `user_avatar` after the click differing from before
    // (the subject's own model); `.selected` is the DOM half. Both are required, so "the model moved but the UI did
    // not repaint" stays a finding of its own.
    guards.personaPickerChangedThePersonaOnBothLegs = ['gotavern', 'pinned'].every(leg => pickerOf(leg === 'gotavern' ? gotavern : pinned)?.personaChanged === true);
    for (const leg of ['gotavern', 'pinned']) {
        const picker = pickerOf(leg === 'gotavern' ? gotavern : pinned);
        if (picker?.status !== 'observed') {
            findings.push(`${leg}: the persona picker was not driven: ${JSON.stringify(picker?.reason ?? null)}`);
        } else if (picker.clickedWasCurrentBefore !== false) {
            findings.push(`${leg}: the persona picker clicked the ALREADY-SELECTED row (${JSON.stringify(picker.clickedAvatarId)}), which setUserAvatar short-circuits by design; pick another row`);
        } else if (picker.preconditions && (picker.preconditions.delegatedClickBound !== true || picker.preconditions.rowVisible !== true)) {
            // THE CLICK PATH ITSELF, before blaming the product: an unbound delegated handler or a row with no box
            // cannot be clicked by a user either, so the drive must say so instead of reporting the model unchanged.
            findings.push(`${leg}: the persona ROW is not clickable by a user -- ${JSON.stringify(picker.preconditions)}`);
        } else if (picker.personaChanged !== true) {
            findings.push(`${leg}: clicking persona ${JSON.stringify(picker.clickedAvatarId)} did not change user_avatar (direct setUserAvatar call: ${JSON.stringify(picker.directCall ?? null)})`);
        } else if (picker.selectedAfterClick !== true) {
            findings.push(`${leg}: user_avatar became ${JSON.stringify(picker.userAvatarAfter)} but its row was not marked .selected, so the model moved and the UI did not`);
        }
    }

    // ---- A SWIPED MESSAGE'S AVATAR (Q5's missing half) -------------------------------------------
    //
    // About the avatar of a message RE-RENDERED by a swipe, not the first render. The drive records the text
    // before and after, so a swipe that did nothing cannot pass by leaving the same already-decoded avatar.
    const swipeOf = report => dom(report)?.swipedMessageAvatar ?? null;
    guards.swipeChangedTheMessageOnBothLegs = ['gotavern', 'pinned'].every(leg => swipeOf(leg === 'gotavern' ? gotavern : pinned)?.textChanged === true);
    guards.swipedMessageAvatarDecodedOnBothLegs = ['gotavern', 'pinned'].every(leg => {
        const swipe = swipeOf(leg === 'gotavern' ? gotavern : pinned);
        return swipe?.after?.settled === 'loaded' && (swipe?.after?.avatar?.naturalWidth ?? 0) > 0;
    });
    for (const leg of ['gotavern', 'pinned']) {
        const swipe = swipeOf(leg === 'gotavern' ? gotavern : pinned);
        if (swipe?.status !== 'observed') findings.push(`${leg}: the swipe drive was not driven: ${JSON.stringify(swipe?.reason ?? null)}`);
        else if (swipe.textChanged !== true) findings.push(`${leg}: the message text did not change on a swipe, so the avatar measured is the first render's`);
    }

    // ---- THE REAL CARD'S STRUCTURE IS IN PLAY ----------------------------------------------------
    //
    // A leg whose real card failed to stage, or whose staged card the reader did not reach, would report the
    // synthetic-only numbers and look exactly like a pass. The structure is measured BY THE PROBE from the bytes
    // it wrote, so this compares the two legs' staged fixture and requires the book and the greetings to exist.
    const realCardOf = report => report?.provenance?.fixture?.realCard ?? null;
    guards.bothLegsStagedTheRealCard = ['gotavern', 'pinned'].every(leg => {
        const card = realCardOf(leg === 'gotavern' ? gotavern : pinned);
        return Boolean(card) && (card.bookEntries ?? 0) > 0 && (card.alternateGreetings ?? 0) > 0 && card.nameIsMarker === true;
    });
    guards.realCardStructureEqualOnBothLegs = Boolean(realCardOf(gotavern)) && JSON.stringify(realCardOf(gotavern)) === JSON.stringify(realCardOf(pinned));
    if (!guards.realCardStructureEqualOnBothLegs) {
        findings.push(`the two legs staged different real-card structures: gotavern=${JSON.stringify(realCardOf(gotavern))} pinned=${JSON.stringify(realCardOf(pinned))}`);
    }

    guards.backgroundServedWithBytesOnBothLegs = Boolean(backgrounds.gotavern.served && backgrounds.gotavern.served.status === 200 && (backgrounds.gotavern.served.byteLength ?? 0) > 0)
        && Boolean(backgrounds.pinned.served && backgrounds.pinned.served.status === 200 && (backgrounds.pinned.served.byteLength ?? 0) > 0);
    if (!guards.backgroundAppliedOnBothLegs) {
        findings.push(`background not applied: gotavern=${JSON.stringify(backgrounds.gotavern.driven)} pinned=${JSON.stringify(backgrounds.pinned.driven)}`);
    }
    // THE PAINT FAILURE MUST SAY WHICH BRANCH IT SAW, because the three are different findings:
    //   * `selectedTileAfterClick` still naming another file means the CLICK never reached the handler (a probe
    //     defect -- what run 40307800425 measured, where the tile rendered and loaded but `#bg1` kept
    //     `__transparent.png`);
    //   * the right tile selected but `#bg1` unchanged and `chatBackgroundLocked` true is the LOCKED branch, which
    //     paints the locked background and is correct behaviour the drive must not call a failure;
    //   * everything moved but `#bg1` did not is a product finding.
    for (const leg of ['gotavern', 'pinned']) {
        const driven = backgrounds[leg].driven ?? {};
        if (driven.status !== 'observed') continue;
        if (guards.stagedBackgroundPaintedOnBothLegs) continue;
        const selected = driven.selectedTileAfterClick ?? null;
        if (selected !== 'probe-asset-background.png') {
            // THE CAUSE, NAMED. A binding that is absent cannot be painted by any click, so that is a different
            // report from "the binding is there and the click did not reach it".
            const cause = driven.delegatedBgClickBound !== true
                ? `the delegated .bg_example click handler is NOT BOUND -- initBackgrounds() runs AFTER \`await initTokenizers()\` in the page's startup sequence (script.js:757-762), so a rejection there skips it with no page error; startup evidence: ${JSON.stringify(driven.startupEvidence ?? null)}, document click handlers: ${JSON.stringify(driven.handlerSelectors ?? null)}`
                : `the handler is bound (tile box ${JSON.stringify(driven.tileBox ?? null)}) and the click still did not select it`;
            findings.push(`${leg}: the gallery tile click did not select the staged tile (selected tile after click: ${JSON.stringify(selected)}, path: ${JSON.stringify(driven.clickPath ?? null)}) -- ${cause}`);
        } else if (driven.chatBackgroundLocked === true) {
            findings.push(`${leg}: the staged tile was selected but chat_metadata.bg is set, so onSelectBackgroundClick took the LOCKED branch`);
        } else {
            findings.push(`${leg}: the staged tile was selected but #bg1 is ${JSON.stringify(driven.appliedBackgroundImage)}`);
        }
    }

    // ---- cross-leg equality --------------------------------------------------------------------
    // QUERY NORMALISATION, WITH ITS REASON: `getThumbnailUrl(type, file, t)` appends a `t=<Date.now()>`
    // cache-buster, so the same thumbnail appears with a different query on every call. Only that
    // parameter is dropped, only in the COMPARISON KEY, and the full URL stays recorded.
    const normalise = entry => {
        const url = new URL(entry.pathAndQuery, 'http://leg.invalid');
        url.searchParams.delete('t');
        return `${url.pathname}${url.search}`;
    };
    const mapByKey = report => {
        const map = new Map();
        for (const entry of images(report)) map.set(normalise(entry), entry);
        return map;
    };
    const left = mapByKey(gotavern);
    const right = mapByKey(pinned);
    const onlyGotavern = [...left.keys()].filter(key => !right.has(key)).sort();
    const onlyPinned = [...right.keys()].filter(key => !left.has(key)).sort();
    guards.sameImageUrlSet = onlyGotavern.length === 0 && onlyPinned.length === 0;
    if (!guards.sameImageUrlSet) {
        if (onlyGotavern.length) findings.push(`requested only by GoTavern: ${onlyGotavern.join(', ')}`);
        if (onlyPinned.length) findings.push(`requested only by pinned: ${onlyPinned.join(', ')}`);
    }

    const shared = [...left.keys()].filter(key => right.has(key)).sort();
    const statusMismatch = [];
    const contentTypeMismatch = [];
    const byteDifferences = [];
    for (const key of shared) {
        const a = left.get(key);
        const b = right.get(key);
        if (a.status !== b.status) statusMismatch.push({ url: key, gotavern: a.status, pinned: b.status });
        const aType = (a.contentType ?? '').split(';')[0].trim().toLowerCase();
        const bType = (b.contentType ?? '').split(';')[0].trim().toLowerCase();
        if (aType !== bType) contentTypeMismatch.push({ url: key, gotavern: aType, pinned: bType });
        const bytesDiffer = a.sha256 && b.sha256 && a.sha256 !== b.sha256;
        if (bytesDiffer) {
            byteDifferences.push({ url: key, kind: a.kind, gotavern: { byteLength: a.byteLength, sha256: a.sha256 }, pinned: { byteLength: b.byteLength, sha256: b.sha256 } });
        }
    }
    guards.perUrlStatusEqual = statusMismatch.length === 0;
    guards.perUrlContentTypeEqual = contentTypeMismatch.length === 0;
    for (const mismatch of statusMismatch) findings.push(`status differs for ${mismatch.url}: gotavern ${mismatch.gotavern} vs pinned ${mismatch.pinned}`);
    for (const mismatch of contentTypeMismatch) findings.push(`content-type differs for ${mismatch.url}: gotavern ${mismatch.gotavern || '(none)'} vs pinned ${mismatch.pinned || '(none)'}`);

    // BYTES: equal for everything except `/thumbnail`, where the codec is a DECLARED divergence
    // (ARCHITECTURE.md §35.2). A difference anywhere else is a failure -- that is the whole point of
    // recording digests rather than lengths.
    const undeclaredByteDifferences = byteDifferences.filter(difference => difference.kind !== 'thumbnail');
    guards.nonThumbnailBytesEqual = undeclaredByteDifferences.length === 0;
    for (const difference of undeclaredByteDifferences) {
        findings.push(`bytes differ for ${difference.url} (${difference.kind}): ${difference.gotavern.byteLength}B vs ${difference.pinned.byteLength}B`);
    }
    for (const difference of byteDifferences.filter(entry => entry.kind === 'thumbnail')) {
        divergences.push({
            kind: 'codec',
            url: difference.url,
            reason: 'ARCHITECTURE.md §35.2: pinned renders thumbnails with Jimp; GoTavern uses a pure-Go codec. The product claims the OBSERVABLE (status, MIME, decodable image, configured dimensions), not the bytes.',
            gotavern: difference.gotavern,
            pinned: difference.pinned,
        });
    }
    // A THUMBNAIL THAT MISMATCHES IN STATUS IS NEVER A DIVERGENCE. Stated as its own guard because this
    // is exactly the sentence that was missing when the 404 was folded into "codec boundary".
    guards.thumbnailDivergenceIsBytesOnly = divergences.every(divergence => divergence.kind === 'codec' && !('status' in divergence));
    guards.thumbnailResponsesAreImages = images(gotavern).filter(entry => entry.kind === 'thumbnail').every(entry => entry.status === 200 && /^image\//i.test(entry.contentType ?? '') && (entry.byteLength ?? 0) > 0)
        && images(pinned).filter(entry => entry.kind === 'thumbnail').every(entry => entry.status === 200 && /^image\//i.test(entry.contentType ?? '') && (entry.byteLength ?? 0) > 0);

    // ---- the browser's own complaints ----------------------------------------------------------
    const failTexts = report => (report?.consoleFailedToLoad ?? []).map(entry => String(entry.text));
    const gotavernFails = failTexts(gotavern);
    const pinnedFails = failTexts(pinned);
    // SET DIFFERENCE, NOT A COUNT: a page may legitimately complain about something both legs share
    // (a blocked CDN, a favicon). What may not happen is GoTavern complaining about something pinned does
    // not -- and there is no allowlist here, because the allowlist is what turned the 404 into a pass.
    const extraOnGotavern = gotavernFails.filter(text => !pinnedFails.includes(text));
    guards.noExtraConsoleLoadFailuresOnGotavern = extraOnGotavern.length === 0;
    for (const text of extraOnGotavern) findings.push(`gotavern console: ${text} -- pinned has no such message`);

    guards.noPageErrors = (gotavern?.pageErrors ?? []).length === 0 && (pinned?.pageErrors ?? []).length === 0;
    guards.noFailedImageRequestsRecordedAsFailures = (gotavern?.httpFailures ?? []).length === 0 && (pinned?.httpFailures ?? []).length === 0;
    guards.bothLegsCompleted = !gotavern?.failure && !pinned?.failure;
    if (gotavern?.failure) findings.push(`gotavern leg failed: ${String(gotavern.failure).split('\n')[0]}`);
    if (pinned?.failure) findings.push(`pinned leg failed: ${String(pinned.failure).split('\n')[0]}`);

    // THE LOOPBACK ORIGIN BELONGS TO THE RUN, NOT TO THE PRODUCT. `resolvedSrc` and the applied
    // `background-image` are absolute because the browser resolves them, and each leg ran on its own port
    // (measured: 40653 on GoTavern, 42429 on pinned in run 40207520868, which the host-derived sweep correctly
    // refused). A committed artefact may not carry a port, so the origin is replaced with a marker and the
    // replacement is recorded in `normalisations` -- the same treatment the generation comparator gives a mock
    // origin. Nothing else about the URL is touched: the path and query are the observation.
    const stripOrigin = value => (typeof value === 'string'
        ? value.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/i, '<loopback>')
        : value);
    const projectImages = report => (dom(report)?.characterList ?? []).map(image => ({ ...image, resolvedSrc: stripOrigin(image.resolvedSrc) }));
    const projectMessages = report => (dom(report)?.messages ?? []).map(image => ({ ...image, resolvedSrc: stripOrigin(image.resolvedSrc) }));
    const projectBackground = leg => ({
        ...backgrounds[leg],
        url: stripOrigin(backgrounds[leg].url),
        driven: backgrounds[leg].driven ? {
            ...backgrounds[leg].driven,
            appliedBackgroundImage: stripOrigin(backgrounds[leg].driven.appliedBackgroundImage),
            tileThumbnailBeforeLoad: stripOrigin(backgrounds[leg].driven.tileThumbnailBeforeLoad),
            tileThumbnailAfterLoad: stripOrigin(backgrounds[leg].driven.tileThumbnailAfterLoad),
        } : backgrounds[leg].driven,
    });

    // WHAT THIS ARTEFACT STILL DOES NOT PROVE. The three entries that stood here -- the backgrounds gallery
    // paint, the persona picker and a swiped message avatar -- are GONE because they are now driven and guarded
    // above; leaving them would be a claim of unproven-ness the artefact contradicts. What remains is stated with
    // the reason it cannot be asserted here rather than omitted.
    const projectPicker = report => {
        const picker = pickerOf(report);
        if (!picker) return null;
        // THE ROW IMAGE'S RESOLVED ORIGIN IS THE RUN'S, NOT THE PRODUCT'S, so it is normalised exactly as the
        // character-list images are -- and the normalisation is recorded in `normalisations`, because a field
        // rewritten without a reason is how a host value gets committed.
        return {
            ...picker,
            rowImage: picker.rowImage ? { ...picker.rowImage, resolvedSrc: stripOrigin(picker.rowImage.resolvedSrc) } : null,
        };
    };
    const projectSwipe = report => {
        const swipe = swipeOf(report);
        if (!swipe) return null;
        return {
            ...swipe,
            before: swipe.before?.avatar ? { ...swipe.before, avatar: { ...swipe.before.avatar, resolvedSrc: stripOrigin(swipe.before.avatar.resolvedSrc) } } : swipe.before,
            after: swipe.after?.avatar ? { ...swipe.after, avatar: { ...swipe.after.avatar, resolvedSrc: stripOrigin(swipe.after.avatar.resolvedSrc) } } : swipe.after,
        };
    };
    const projectGallery = report => {
        const driven = dom(report)?.backgroundDriven ?? null;
        if (!driven) return null;
        return {
            status: driven.status ?? null,
            reason: driven.reason ?? null,
            tileBgFile: driven.tileBgFile ?? null,
            tileThumbnailBeforeLoad: stripOrigin(driven.tileThumbnailBeforeLoad),
            tileThumbnailAfterLoad: stripOrigin(driven.tileThumbnailAfterLoad),
            appliedBackgroundImage: stripOrigin(driven.appliedBackgroundImage),
            // THE CLICK-PATH EVIDENCE, so a reader (and the next run) can see WHY the click did or did not work
            // instead of reading a conclusion: the jQuery handlers actually bound on `document`, the boolean the
            // comparator reads, the tile's box, and the branch the handler took.
            handlerSelectors: driven.handlerSelectors ?? null,
            startupEvidence: driven.startupEvidence ?? null,
            delegatedBgClickBound: driven.delegatedBgClickBound ?? null,
            tileBox: driven.tileBox ?? null,
            clickPath: driven.clickPath ?? null,
            selectedTileBeforeClick: driven.selectedTileBeforeClick ?? null,
            selectedTileAfterClick: driven.selectedTileAfterClick ?? null,
            chatBackgroundLocked: driven.chatBackgroundLocked ?? null,
            backgroundSettingsName: driven.backgroundSettingsName ?? null,
            gallery: driven.gallery ? {
                tiles: driven.gallery.tiles ?? 0,
                // NOT TRUNCATED: the artefact records every bgfile, because a slice of the list is what produced
                // the false "the gallery did not render the staged tile" finding in run 40307800425.
                bgFiles: driven.gallery.bgFiles ?? [],
                stagedTilePresent: driven.gallery.stagedTilePresent === true,
                drawerOpen: driven.gallery.drawerOpen === true,
                drawerOpenedByDrive: driven.gallery.drawerOpenedByDrive ?? null,
                drawerWasAlreadyOpen: driven.gallery.drawerWasAlreadyOpen ?? null,
                fetchError: driven.gallery.fetchError ?? null,
            } : null,
        };
    };

    const unprovenEntries = [
        'image dimensions equal to the configured thumbnail size: both legs report a decoded thumbnail and the configured size is not asserted here, because the configured size comes from the user\'s own config.yaml and the probe seeds the pinned default; asserting it would test the seed, not the codec',
        'a real user tree with a hundred cards, where the character list paginates: the probe stages two cards and pagination needs a page size the user sets; the committed derivation proves the STRUCTURE of one real card, not the list\'s paging behaviour',
        'the gallery PAINT is asserted for a SYSTEM background chosen from the gallery; a per-chat background (chat_metadata) and a locked background take the other branch of `onSelectBackgroundClick` and are not driven here',
    ];
    // A GUARD THAT FAILS AND IS DECLARED UNPROVEN DOES NOT FAIL THE RUN, BUT IT IS NAMED BOTH IN `unproven`
    // AND IN `declaredUnproven`, so a reader and the verifier both see it. Everything else fails.
    const declaredUnproven = new Set(unprovenEntries.map(entry => String(entry).split(':')[0].trim()));
    const failedGuards = Object.entries(guards)
        .filter(([name, value]) => value !== true && !declaredUnproven.has(name))
        .map(([name]) => name);

    return {
        schemaVersion: 1,
        question: 'Does a browser loading the unmodified pinned frontend display the character-list avatars, the chat-message avatars, the persona thumbnail and the background, on BOTH legs, and does every image the page asks for answer with bytes?',
        // The mapping to the user's own words, so a reader can see which complaint this answers.
        answers: {
            'Q3 character-list avatars': 'guards.everyCharacterListAvatarDecoded + guards.noImageRequestFailedOnEitherLeg',
            'Q5 chat avatar': 'guards.everyMessageAvatarDecoded + guards.swipedMessageAvatarDecodedOnBothLegs + guards.swipeChangedTheMessageOnBothLegs (the avatar of a message RE-RENDERED by a swipe)',
            'Q6 personas': 'guards.personaPickerRenderedOnBothLegs + guards.personaPickerRowImageDecodedOnBothLegs + guards.personaPickerSelectedOnBothLegs + guards.thumbnailResponsesAreImages',
            'Q7 backgrounds': 'guards.galleryRenderedTheStagedTileOnBothLegs + guards.galleryTileThumbnailPaintedOnBothLegs + guards.stagedBackgroundPaintedOnBothLegs + guards.backgroundServedWithBytesOnBothLegs',
            'the real card': 'guards.bothLegsStagedTheRealCard + guards.realCardStructureEqualOnBothLegs (tests/browser/fixtures/real/card-a.png, the committed derivation)',
        },
        legs: {
            gotavern: {
                subject: gotavern?.subject ?? null,
                countLoaded: gotavern?.countLoaded ?? null,
                imageRequests: images(gotavern).map(entry => ({ url: entry.pathAndQuery, kind: entry.kind, status: entry.status, contentType: entry.contentType, byteLength: entry.byteLength, sha256: entry.sha256 })),
                consoleFailedToLoad: gotavernFails,
                pageErrors: gotavern?.pageErrors ?? [],
                background: projectBackground('gotavern'),
                characterList: projectImages(gotavern),
                messages: projectMessages(gotavern),
                personaRequest: dom(gotavern)?.personaRequest ?? null,
                personaPicker: projectPicker(gotavern),
                backgroundGallery: projectGallery(gotavern),
                swipedMessageAvatar: projectSwipe(gotavern),
                realCard: realCardOf(gotavern),
            },
            pinned: {
                subject: pinned?.subject ?? null,
                countLoaded: pinned?.countLoaded ?? null,
                imageRequests: images(pinned).map(entry => ({ url: entry.pathAndQuery, kind: entry.kind, status: entry.status, contentType: entry.contentType, byteLength: entry.byteLength, sha256: entry.sha256 })),
                consoleFailedToLoad: pinnedFails,
                pageErrors: pinned?.pageErrors ?? [],
                background: projectBackground('pinned'),
                characterList: projectImages(pinned),
                messages: projectMessages(pinned),
                personaRequest: dom(pinned)?.personaRequest ?? null,
                personaPicker: projectPicker(pinned),
                backgroundGallery: projectGallery(pinned),
                swipedMessageAvatar: projectSwipe(pinned),
                realCard: realCardOf(pinned),
            },
        },
        guards,
        failedGuards,
        divergences,
        normalisations: [{
            field: 'legs.*.{resolvedSrc,background.url,appliedBackgroundImage,tileThumbnailBeforeLoad,tileThumbnailAfterLoad}',
            change: 'a loopback origin (the IPv4 loopback block, `localhost`, or the IPv6 loopback) together with its port is replaced with <loopback>; the literal address is deliberately not written in this file, because the host-derived sweep reads it and would refuse it',
            reason: 'each leg runs on its own port (measured 40653 vs 42429 in run 40207520868), so the origin is a property of the run and not of the product; the path and query ARE the observation and are untouched',
            source: 'this artefact, plus the host-derived sweep in tools/verify-browser-comparisons.mjs which refused the committed port',
        },{
            field: 'imageRequests[].url (comparison key only)',
            change: 'the `t=<Date.now()>` cache-buster is dropped',
            reason: 'public/script.js getThumbnailUrl(type, file, t) appends Date.now() so the same thumbnail has a different query on every call; the recorded url keeps it',
            source: 'public/script.js:getThumbnailUrl (pinned)',
        }],
        findings,
        // WHAT THIS ARTEFACT DOES NOT PROVE, in the artefact rather than in a commit message. The verifier
        // REQUIRES a false guard to be named here (tools/browser-evidence/other-surfaces.mjs), so an unproven
        // half cannot be omitted instead of declared.
        unproven: unprovenEntries,
        declaredUnproven: [...declaredUnproven].sort(),
    };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
    const [gotavernPath, pinnedPath] = process.argv.slice(2).filter(argument => argument.endsWith('.json'));
    if (!gotavernPath || !pinnedPath) {
        console.error('usage: node compare-asset-legs.mjs <gotavern-leg.json> <pinned-leg.json>');
        process.exit(2);
    }
    const read = file => JSON.parse(readFileSync(path.resolve(file), 'utf8'));
    const artifact = compare({ gotavern: read(gotavernPath), pinned: read(pinnedPath) });
    console.log(JSON.stringify(artifact, null, 2));
    if (artifact.failedGuards.length > 0) {
        console.error(`unfaithful asset differential, ${artifact.failedGuards.length} guard(s) failed: ${artifact.failedGuards.join(', ')}`);
        for (const finding of artifact.findings) console.error(`  ${finding}`);
        process.exitCode = 1;
    }
}
