#!/usr/bin/env node
// PROVE THE ASSET COMPARATOR'S NEW GUARDS CAN FAIL.
//
// AGENTS.md verification rule 7 and differential doctrine 4. The three surfaces added to `asset-comparison.json`
// -- the backgrounds GALLERY paint, the persona PICKER and a SWIPED message avatar -- are the ones the artefact
// listed as unproven for months. A guard added for a surface nobody could prove is worth nothing unless it is
// shown going RED on an input where the surface is broken, so every case below builds two synthetic legs (one
// faithful, one broken in ONE named way) and requires the named guard to be the one that fails.
//
// Every input is synthesised in memory; no browser, no server, no committed leg. The comparator is imported, not
// re-implemented, so the proof is against the program CI runs (differential doctrine 3).
//
// Usage: node tests/browser/asset-gate-selftest.mjs     (exit 0 = every guard has teeth)

import { compare } from './compare-asset-legs.mjs';

const results = [];
const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

const REAL_CARD = {
    name: 'Real Structure Card', source: 'tests/browser/fixtures/real/card-a.png (the committed derivation)',
    keyword: 'ccv3', alternateGreetings: 5, bookEntries: 490, regexScripts: 11, helperScripts: 1, nameIsMarker: true,
};
const FIXTURE_FILES = [
    { relative: 'default-user/characters/Probe Asset Card.png', byteLength: 100, sha256: 'a' },
    { relative: 'default-user/characters/Real Structure Card.png', byteLength: 200, sha256: 'b' },
    { relative: 'default-user/backgrounds/probe-asset-background.png', byteLength: 120, sha256: 'c' },
    { relative: 'default-user/User Avatars/probe-asset-persona.png', byteLength: 130, sha256: 'd' },
];

/** A leg in which every guard the comparator requires is TRUE. Cases below break exactly one thing. */
function faithfulLeg(subject) {
    return {
        subject,
        provenance: { fixture: { userHandle: 'default-user', files: FIXTURE_FILES, realCard: REAL_CARD } },
        imageRequests: [
            { pathAndQuery: '/backgrounds/__transparent.png', path: '/backgrounds/__transparent.png', kind: 'background', status: 200, contentType: 'image/png', byteLength: 68, sha256: 'aa' },
            { pathAndQuery: '/backgrounds/probe-asset-background.png', path: '/backgrounds/probe-asset-background.png', kind: 'background', status: 200, contentType: 'image/png', byteLength: 124, sha256: 'bb' },
            { pathAndQuery: '/thumbnail?type=avatar&file=Probe%20Asset%20Card.png', path: '/thumbnail', kind: 'thumbnail', status: 200, contentType: 'image/png', byteLength: 911, sha256: 'cc' },
            { pathAndQuery: '/thumbnail?type=persona&file=probe-asset-persona.png', path: '/thumbnail', kind: 'thumbnail', status: 200, contentType: 'image/png', byteLength: 912, sha256: 'dd' },
        ],
        dom: {
            characterListPresent: true,
            characterListCount: 2,
            characterList: [
                { src: '/thumbnail?type=avatar&file=Probe%20Asset%20Card.png', resolvedSrc: 'http://127.0.0.1:1/thumbnail?type=avatar&file=Probe%20Asset%20Card.png', complete: true, naturalWidth: 96, naturalHeight: 96 },
                { src: '/thumbnail?type=avatar&file=Real%20Structure%20Card.png', resolvedSrc: 'http://127.0.0.1:1/thumbnail?type=avatar&file=Real%20Structure%20Card.png', complete: true, naturalWidth: 96, naturalHeight: 96 },
            ],
            messageCount: 1,
            messages: [{ src: '/thumbnail?type=avatar&file=Real%20Structure%20Card.png', resolvedSrc: 'http://127.0.0.1:1/x', complete: true, naturalWidth: 96, naturalHeight: 96 }],
            background: { computedBackgroundImage: 'url("http://127.0.0.1:1/backgrounds/probe-asset-background.png")' },
            stagedBackgroundRequest: { url: '/backgrounds/probe-asset-background.png', httpStatus: 200, contentType: 'image/png', byteLength: 124 },
            stagedBackgroundDriven: true,
            backgroundDriven: {
                status: 'observed',
                tileBgFile: 'probe-asset-background.png',
                tileThumbnailBeforeLoad: 'url(""/img/placeholder.png"")',
                tileThumbnailAfterLoad: 'url("http://127.0.0.1:1/thumbnail?type=bg&file=probe-asset-background.png")',
                appliedBackgroundImage: 'url("http://127.0.0.1:1/backgrounds/probe-asset-background.png")',
                gallery: {
                    tiles: 2,
                    bgFiles: ['__transparent.png', 'probe-asset-background.png'],
                    drawerOpen: true,
                    fetchError: null,
                    fetched: { returned: 'null' },
                    panelContent: '<div class="bg_example" bgfile="probe-asset-background.png"></div>',
                },
            },
            personaPicker: {
                status: 'observed',
                listed: 2,
                rowCount: 2,
                steps: ['getUserAvatars(true)', 'opened the drawer', 'clicked the row'],
                rowImage: { src: '/thumbnail?type=persona&file=probe-asset-persona.png', resolvedSrc: 'http://127.0.0.1:1/thumbnail?type=persona&file=probe-asset-persona.png', complete: true, naturalWidth: 96, naturalHeight: 96, settled: 'loaded' },
                selectedAfterClick: true,
                currentPersonaHeading: 'Probe Persona',
            },
            personaRequest: { status: 'observed', url: '/thumbnail?type=persona&file=probe-asset-persona.png', httpStatus: 200, contentType: 'image/png', byteLength: 912 },
            swipedMessageAvatar: {
                status: 'observed',
                character: 'Real Structure Card',
                before: { text: 'PROBE_ASSET_GREETING hello', avatar: { src: '/thumbnail?type=avatar&file=Real%20Structure%20Card.png', resolvedSrc: 'http://127.0.0.1:1/a', complete: true, naturalWidth: 96, naturalHeight: 96 }, settled: 'loaded' },
                after: { text: 'MARK_000123 the second greeting', avatar: { src: '/thumbnail?type=avatar&file=Real%20Structure%20Card.png', resolvedSrc: 'http://127.0.0.1:1/a', complete: true, naturalWidth: 96, naturalHeight: 96 }, settled: 'loaded' },
                textChanged: true,
            },
        },
        consoleFailedToLoad: [],
        pageErrors: [],
        httpFailures: [],
        failure: null,
    };
}

const baseline = compare({ gotavern: faithfulLeg('gotavern'), pinned: faithfulLeg('pinned') });
record('a faithful pair produces NO failed guards', baseline.failedGuards.length === 0, baseline.failedGuards.join(', '));

/** Break ONE thing on both legs and require the NAMED guard to be the one that fails. */
function expects(name, guardName, mutate) {
    const gotavern = faithfulLeg('gotavern');
    const pinned = faithfulLeg('pinned');
    mutate(gotavern);
    mutate(pinned);
    const artifact = compare({ gotavern, pinned });
    const fired = artifact.guards[guardName] !== true;
    const reported = artifact.failedGuards.includes(guardName);
    record(name, fired && reported, fired ? (reported ? undefined : `guard ${guardName} is false but failedGuards=${JSON.stringify(artifact.failedGuards)}`) : `guard ${guardName} stayed ${JSON.stringify(artifact.guards[guardName])}`);
}

// ---- the gallery paint ---------------------------------------------------------------------------
expects('gallery rendered no tile -> galleryRenderedTheStagedTileOnBothLegs fails', 'galleryRenderedTheStagedTileOnBothLegs', leg => {
    leg.dom.backgroundDriven = { status: 'not-driven', reason: 'no .bg_example appeared', gallery: { tiles: 0, bgFiles: [], drawerOpen: true, fetchError: null, fetched: { returned: 'null' } } };
    leg.dom.stagedBackgroundDriven = false;
});
expects('gallery rendered OTHER tiles but not the staged one -> galleryRenderedTheStagedTileOnBothLegs fails', 'galleryRenderedTheStagedTileOnBothLegs', leg => {
    leg.dom.backgroundDriven.gallery.tiles = 3;
    leg.dom.backgroundDriven.gallery.bgFiles = ['__transparent.png', 'a.png', 'b.png'];
});
expects('tile thumbnail stayed on the placeholder -> galleryTileThumbnailPaintedOnBothLegs fails', 'galleryTileThumbnailPaintedOnBothLegs', leg => {
    leg.dom.backgroundDriven.tileThumbnailAfterLoad = 'none';
});
expects('clicking the tile did not change #bg1 -> stagedBackgroundDrivenOnBothLegs fails', 'stagedBackgroundDrivenOnBothLegs', leg => {
    leg.dom.backgroundDriven.appliedBackgroundImage = 'url("/backgrounds/__transparent.png")';
    leg.dom.stagedBackgroundDriven = false;
});

// ---- the persona picker --------------------------------------------------------------------------
expects('picker rendered no row -> personaPickerRenderedOnBothLegs fails', 'personaPickerRenderedOnBothLegs', leg => {
    leg.dom.personaPicker = { status: 'not-driven', reason: 'no .avatar-container appeared', listed: 2, rowCount: 0, rowIds: [] };
});
expects('picker row image was broken -> personaPickerRowImageDecodedOnBothLegs fails', 'personaPickerRowImageDecodedOnBothLegs', leg => {
    leg.dom.personaPicker.rowImage = { src: '/thumbnail?type=persona&file=probe-asset-persona.png', complete: true, naturalWidth: 0, naturalHeight: 0, settled: 'broken' };
});
expects('clicking the row did not select it -> personaPickerSelectedOnBothLegs fails', 'personaPickerSelectedOnBothLegs', leg => {
    leg.dom.personaPicker.selectedAfterClick = false;
});

// ---- the swiped message avatar -------------------------------------------------------------------
expects('swipe did not change the text -> swipeChangedTheMessageOnBothLegs fails', 'swipeChangedTheMessageOnBothLegs', leg => {
    leg.dom.swipedMessageAvatar.after.text = leg.dom.swipedMessageAvatar.before.text;
    leg.dom.swipedMessageAvatar.textChanged = false;
});
expects('the re-rendered avatar was broken -> swipedMessageAvatarDecodedOnBothLegs fails', 'swipedMessageAvatarDecodedOnBothLegs', leg => {
    leg.dom.swipedMessageAvatar.after.avatar = { src: '/thumbnail?type=avatar&file=Real%20Structure%20Card.png', complete: true, naturalWidth: 0, naturalHeight: 0 };
    leg.dom.swipedMessageAvatar.after.settled = 'broken';
});
expects('the swipe drive never ran -> swipeChangedTheMessageOnBothLegs and swipedMessageAvatarDecodedOnBothLegs fail', 'swipedMessageAvatarDecodedOnBothLegs', leg => {
    leg.dom.swipedMessageAvatar = { status: 'not-driven', reason: 'no .swipe_right' };
});

// ---- the real card is in play ---------------------------------------------------------------------
expects('the real card did not stage -> bothLegsStagedTheRealCard fails', 'bothLegsStagedTheRealCard', leg => {
    leg.provenance.fixture.realCard = { ...REAL_CARD, bookEntries: 0, alternateGreetings: 0 };
});
expects('one leg staged a different card -> realCardStructureEqualOnBothLegs fails', 'realCardStructureEqualOnBothLegs', leg => {
    if (leg.subject === 'pinned') leg.provenance.fixture.realCard = { ...REAL_CARD, bookEntries: 32 };
});

// ---- and the guards that already existed must still have teeth ------------------------------------
expects('a 404 on an image -> noImageRequestFailedOnEitherLeg fails', 'noImageRequestFailedOnEitherLeg', leg => {
    leg.imageRequests[1].status = 404;
});
expects('an undecoded character-list avatar -> everyCharacterListAvatarDecoded fails', 'everyCharacterListAvatarDecoded', leg => {
    leg.dom.characterList[0].complete = false;
});

// ---- the unproven list must not name a guard that now passes --------------------------------------
// The artefact's `unproven[]` is what lets a false guard live honestly. An entry naming a guard that is TRUE is
// stale documentation, so it is checked here: every entry whose text starts with a guard name must be a FALSE
// guard in the baseline, and every FALSE guard must be named (the verifier enforces the second half).
{
    const declared = new Set(baseline.declaredUnproven);
    const stale = [...declared].filter(name => baseline.guards[name] === true);
    record('no unproven[] entry names a guard that passes', stale.length === 0, stale.join(', '));
    const undeclared = Object.entries(baseline.guards).filter(([name, value]) => value !== true && !declared.has(name)).map(([name]) => name);
    record('every false guard is declared in unproven[]', undeclared.length === 0, undeclared.join(', '));
}

const failed = results.filter(entry => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} case(s) behaved as required`);
if (failed.length > 0) {
    console.error(`DECORATION: ${failed.map(entry => entry.name).join(', ')}`);
    process.exit(1);
}
