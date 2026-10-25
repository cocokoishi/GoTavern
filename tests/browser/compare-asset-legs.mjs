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
    guards.backgroundServedWithBytesOnBothLegs = Boolean(backgrounds.gotavern.served && backgrounds.gotavern.served.status === 200 && (backgrounds.gotavern.served.byteLength ?? 0) > 0)
        && Boolean(backgrounds.pinned.served && backgrounds.pinned.served.status === 200 && (backgrounds.pinned.served.byteLength ?? 0) > 0);
    if (!guards.backgroundAppliedOnBothLegs) {
        findings.push(`background not applied: gotavern=${JSON.stringify(backgrounds.gotavern.driven)} pinned=${JSON.stringify(backgrounds.pinned.driven)}`);
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

    const failedGuards = Object.entries(guards).filter(([, value]) => value !== true).map(([name]) => name);

    return {
        schemaVersion: 1,
        question: 'Does a browser loading the unmodified pinned frontend display the character-list avatars, the chat-message avatars, the persona thumbnail and the background, on BOTH legs, and does every image the page asks for answer with bytes?',
        // The mapping to the user's own words, so a reader can see which complaint this answers.
        answers: {
            'Q3 character-list avatars': 'guards.everyCharacterListAvatarDecoded + guards.noImageRequestFailedOnEitherLeg',
            'Q5 chat avatar': 'guards.everyMessageAvatarDecoded',
            'Q6 personas': 'partially: guards.thumbnailResponsesAreImages covers the persona thumbnail request; the persona PICKER is not driven (see unproven)',
            'Q7 backgrounds': 'guards.backgroundAppliedOnBothLegs + guards.backgroundServedWithBytesOnBothLegs',
        },
        legs: {
            gotavern: {
                subject: gotavern?.subject ?? null,
                countLoaded: gotavern?.countLoaded ?? null,
                imageRequests: images(gotavern).map(entry => ({ url: entry.pathAndQuery, kind: entry.kind, status: entry.status, contentType: entry.contentType, byteLength: entry.byteLength, sha256: entry.sha256 })),
                consoleFailedToLoad: gotavernFails,
                pageErrors: gotavern?.pageErrors ?? [],
                background: backgrounds.gotavern,
                characterList: dom(gotavern)?.characterList ?? [],
                messages: dom(gotavern)?.messages ?? [],
                personaRequest: dom(gotavern)?.personaRequest ?? null,
            },
            pinned: {
                subject: pinned?.subject ?? null,
                countLoaded: pinned?.countLoaded ?? null,
                imageRequests: images(pinned).map(entry => ({ url: entry.pathAndQuery, kind: entry.kind, status: entry.status, contentType: entry.contentType, byteLength: entry.byteLength, sha256: entry.sha256 })),
                consoleFailedToLoad: pinnedFails,
                pageErrors: pinned?.pageErrors ?? [],
                background: backgrounds.pinned,
                characterList: dom(pinned)?.characterList ?? [],
                messages: dom(pinned)?.messages ?? [],
                personaRequest: dom(pinned)?.personaRequest ?? null,
            },
        },
        guards,
        failedGuards,
        divergences,
        normalisations: [{
            field: 'imageRequests[].url (comparison key only)',
            change: 'the `t=<Date.now()>` cache-buster is dropped',
            reason: 'public/script.js getThumbnailUrl(type, file, t) appends Date.now() so the same thumbnail has a different query on every call; the recorded url keeps it',
            source: 'public/script.js:getThumbnailUrl (pinned)',
        }],
        findings,
        // WHAT THIS ARTEFACT DOES NOT PROVE, in the artefact rather than in a commit message.
        unproven: [
            'the persona PICKER (a persona does not exist in a fresh tree, so the DOM half of Q6 is unproven; only the persona thumbnail REQUEST is asserted)',
            'a swiped or regenerated message avatar (the chat is opened once and one greeting renders)',
            'image dimensions equal to the configured thumbnail size (the pure-Go codec is asserted to decode, not to resize identically)',
            'a real user tree with a hundred cards, where the character list paginates',
        ],
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
