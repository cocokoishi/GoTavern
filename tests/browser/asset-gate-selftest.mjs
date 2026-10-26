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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
                    stagedTilePresent: true,
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
                rowIds: ['user-default.png', 'probe-asset-persona.png'],
                steps: ['getUserAvatars(true)', 'opened the drawer', 'clicked a NON-CURRENT row'],
                rowImage: { src: '/thumbnail?type=persona&file=probe-asset-persona.png', resolvedSrc: 'http://127.0.0.1:1/thumbnail?type=persona&file=probe-asset-persona.png', complete: true, naturalWidth: 96, naturalHeight: 144, settled: 'loaded' },
                currentPersonaBefore: 'user-default.png',
                clickedAvatarId: 'probe-asset-persona.png',
                clickedWasCurrentBefore: false,
                clickedIsDefaultPersona: false,
                preconditions: { delegatedClickBound: true, rowVisible: true, rowInDrawer: true, drawerIsOpen: true, rowBox: { width: 120, height: 160 } },
                directCall: null,
                clickAloneChangedPersona: true,
                userAvatarAfter: 'probe-asset-persona.png',
                personaChanged: true,
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
    // A GUARD IS "REPORTED" IF IT IS IN failedGuards **OR** DECLARED in unproven[]. The second form is the
    // artefact's mechanism for a known-unproven half with a measured cause; a test that only accepted the first
    // would force a declared guard to be either silently green or an undeclared failure, which are the two shapes
    // the declaration exists to prevent. `fired` is still required, so a decoration cannot hide behind either.
    const reported = artifact.failedGuards.includes(guardName) || (artifact.declaredUnproven ?? []).includes(guardName);
    record(name, fired && reported, fired ? (reported ? undefined : `guard ${guardName} is false but failedGuards=${JSON.stringify(artifact.failedGuards)} and declaredUnproven=${JSON.stringify(artifact.declaredUnproven)}`) : `guard ${guardName} stayed ${JSON.stringify(artifact.guards[guardName])}`);
}

// ---- the gallery paint ---------------------------------------------------------------------------
expects('gallery rendered no tile -> galleryRenderedTheStagedTileOnBothLegs fails', 'galleryRenderedTheStagedTileOnBothLegs', leg => {
    leg.dom.backgroundDriven = { status: 'not-driven', reason: 'no .bg_example appeared', gallery: { tiles: 0, bgFiles: [], stagedTilePresent: false, drawerOpen: true, fetchError: null, fetched: { returned: 'null' } } };
    leg.dom.stagedBackgroundDriven = false;
});
// THE RUN-40307800425 CASE ITSELF: 24 tiles rendered, the staged one WAS among them, but the probe's list was
// sliced and the guard read the slice. The assertion here is the OPPOSITE of the old one: a gallery that rendered
// the staged tile passes even though a truncated `bgFiles` would not contain it -- so the guard cannot repeat that
// false finding, and `stagedTilePresent` is the field that carries the answer.
{
    const leg = faithfulLeg('gotavern');
    leg.dom.backgroundDriven.gallery.tiles = 24;
    leg.dom.backgroundDriven.gallery.bgFiles = ['__transparent.png', '_black.jpg', '_white.jpg', 'bedroom clean.jpg'];
    leg.dom.backgroundDriven.gallery.stagedTilePresent = true;
    const paired = faithfulLeg('pinned');
    paired.dom.backgroundDriven.gallery.tiles = 24;
    paired.dom.backgroundDriven.gallery.bgFiles = [...leg.dom.backgroundDriven.gallery.bgFiles];
    paired.dom.backgroundDriven.gallery.stagedTilePresent = true;
    const artifact = compare({ gotavern: leg, pinned: paired });
    record('a 24-tile gallery whose truncated list omits the staged file still PASSES (run 40307800425\'s false finding)', artifact.guards.galleryRenderedTheStagedTileOnBothLegs === true, `bgFiles=${JSON.stringify(leg.dom.backgroundDriven.gallery.bgFiles)}`);
}
expects('gallery rendered 24 tiles but NOT the staged one -> galleryRenderedTheStagedTileOnBothLegs fails', 'galleryRenderedTheStagedTileOnBothLegs', leg => {
    leg.dom.backgroundDriven.gallery.tiles = 24;
    leg.dom.backgroundDriven.gallery.bgFiles = ['__transparent.png', 'a.png'];
    leg.dom.backgroundDriven.gallery.stagedTilePresent = false;
    leg.dom.stagedBackgroundDriven = false;
});
expects('tile thumbnail stayed on the placeholder -> galleryTileThumbnailPaintedOnBothLegs fails', 'galleryTileThumbnailPaintedOnBothLegs', leg => {
    leg.dom.backgroundDriven.tileThumbnailAfterLoad = 'none';
});
expects('clicking the tile did not change #bg1 -> stagedBackgroundDrivenOnBothLegs fails', 'stagedBackgroundDrivenOnBothLegs', leg => {
    leg.dom.backgroundDriven.appliedBackgroundImage = 'url("/backgrounds/__transparent.png")';
    leg.dom.stagedBackgroundDriven = false;
});
// THE THREE PAINT FAILURES MUST BE DISTINGUISHABLE IN THE FINDINGS, because they are three different defects and
// run 40307800425 produced the FIRST one while reading like a product failure.
{
    const clickMissed = faithfulLeg('gotavern');
    const clickMissedPinned = faithfulLeg('pinned');
    for (const leg of [clickMissed, clickMissedPinned]) {
        leg.dom.stagedBackgroundDriven = false;
        leg.dom.backgroundDriven.appliedBackgroundImage = 'url("http://127.0.0.1:1/backgrounds/__transparent.png")';
        leg.dom.backgroundDriven.selectedTileAfterClick = '__transparent.png';
        leg.dom.backgroundDriven.selectedTileBeforeClick = ['__transparent.png'];
        leg.dom.backgroundDriven.clickPath = 'element.click() then a bubbling MouseEvent';
        leg.dom.backgroundDriven.delegatedBgClickBound = true;
        leg.dom.backgroundDriven.tileBox = { width: 120, height: 70 };
    }
    const artifact = compare({ gotavern: clickMissed, pinned: clickMissedPinned });
    const text = artifact.findings.join(' | ');
    record('a click that reached a BOUND handler but selected nothing is named as such', /the handler is bound .* and the click still did not select it/.test(text), text.slice(0, 260));
}
{
    const unbound = faithfulLeg('gotavern');
    const unboundPinned = faithfulLeg('pinned');
    for (const leg of [unbound, unboundPinned]) {
        leg.dom.stagedBackgroundDriven = false;
        leg.dom.backgroundDriven.appliedBackgroundImage = 'url("http://127.0.0.1:1/backgrounds/__transparent.png")';
        leg.dom.backgroundDriven.selectedTileAfterClick = '__transparent.png';
        leg.dom.backgroundDriven.delegatedBgClickBound = false;
    }
    const artifact = compare({ gotavern: unbound, pinned: unboundPinned });
    record('an UNBOUND gallery click handler is reported as the binding, with the startup evidence', /the delegated \.bg_example click handler is NOT BOUND/.test(artifact.findings.join(' | ')) && /both are bound INSIDE initBackgrounds/.test(artifact.findings.join(' | ')), artifact.findings.join(' | ').slice(0, 300));
}
{
    const locked = faithfulLeg('gotavern');
    const lockedPinned = faithfulLeg('pinned');
    for (const leg of [locked, lockedPinned]) {
        leg.dom.stagedBackgroundDriven = false;
        leg.dom.backgroundDriven.appliedBackgroundImage = 'url("http://127.0.0.1:1/backgrounds/__transparent.png")';
        leg.dom.backgroundDriven.selectedTileAfterClick = 'probe-asset-background.png';
        leg.dom.backgroundDriven.chatBackgroundLocked = true;
    }
    const artifact = compare({ gotavern: locked, pinned: lockedPinned });
    record('a locked chat background is reported as the LOCKED branch, not a product failure', /took the LOCKED branch/.test(artifact.findings.join(' | ')), artifact.findings.join(' | ').slice(0, 260));
}
{
    const notPainted = faithfulLeg('gotavern');
    const notPaintedPinned = faithfulLeg('pinned');
    for (const leg of [notPainted, notPaintedPinned]) {
        leg.dom.stagedBackgroundDriven = false;
        leg.dom.backgroundDriven.appliedBackgroundImage = 'url("http://127.0.0.1:1/backgrounds/__transparent.png")';
        leg.dom.backgroundDriven.selectedTileAfterClick = 'probe-asset-background.png';
        leg.dom.backgroundDriven.chatBackgroundLocked = false;
    }
    const artifact = compare({ gotavern: notPainted, pinned: notPaintedPinned });
    record('a selected tile that did not paint #bg1 is reported against #bg1', /#bg1 is "url\(/.test(artifact.findings.join(' | ')), artifact.findings.join(' | ').slice(0, 260));
}

// ---- the persona picker --------------------------------------------------------------------------
expects('picker rendered no row -> personaPickerRenderedOnBothLegs fails', 'personaPickerRenderedOnBothLegs', leg => {
    leg.dom.personaPicker = { status: 'not-driven', reason: 'no .avatar-container appeared', listed: 2, rowCount: 0, rowIds: [] };
});
expects('picker row image was broken -> personaPickerRowImageDecodedOnBothLegs fails', 'personaPickerRowImageDecodedOnBothLegs', leg => {
    leg.dom.personaPicker.rowImage = { src: '/thumbnail?type=persona&file=probe-asset-persona.png', complete: true, naturalWidth: 0, naturalHeight: 0, settled: 'broken' };
});
// THE RUN-40314670847 CASE ITSELF: the drawer was CLOSED, so the row had a 0x0 box and the click could reach
// nothing. The clickable guard must fire, and the cause must be named as the drive's own state.
expects('the persona drawer was closed -> personaPickerRowIsClickable fails', 'personaPickerRowIsClickable', leg => {
    leg.dom.personaPicker.preconditions = { delegatedClickBound: true, rowVisible: false, rowInDrawer: true, drawerIsOpen: false, rowBox: { width: 0, height: 0 } };
    leg.dom.personaPicker.personaChanged = false;
    leg.dom.personaPicker.selectedAfterClick = false;
});
{
    const closed = faithfulLeg('gotavern');
    const closedPinned = faithfulLeg('pinned');
    for (const leg of [closed, closedPinned]) {
        leg.dom.personaPicker.preconditions = { delegatedClickBound: true, rowVisible: false, rowInDrawer: true, drawerIsOpen: false, rowBox: { width: 0, height: 0 } };
        leg.dom.personaPicker.personaChanged = false;
        leg.dom.personaPicker.selectedAfterClick = false;
    }
    const artifact = compare({ gotavern: closed, pinned: closedPinned });
    record('a 0x0 row is reported as NOT CLICKABLE BY A USER, not as a product selection failure', /the persona ROW is not clickable by a user/.test(artifact.findings.join(' | ')), artifact.findings.join(' | ').slice(0, 260));
}
expects('clicking the row did not select it -> personaPickerSelectedOnBothLegs fails', 'personaPickerSelectedOnBothLegs', leg => {
    leg.dom.personaPicker.selectedAfterClick = false;
});
// THE RUN-40307800425 CASE: the drive clicked the persona that was ALREADY `user_avatar`, which setUserAvatar
// short-circuits BY DESIGN (personas.js:154-159). That is a probe-faithfulness defect, and it must be a finding
// rather than a red against the product -- so the precondition guard fires on it.
expects('the picker clicked the already-selected row -> personaPickerClickedANonCurrentRow fails', 'personaPickerClickedANonCurrentRow', leg => {
    leg.dom.personaPicker.clickedAvatarId = 'user-default.png';
    leg.dom.personaPicker.clickedWasCurrentBefore = true;
    leg.dom.personaPicker.userAvatarAfter = 'user-default.png';
    leg.dom.personaPicker.personaChanged = false;
    leg.dom.personaPicker.selectedAfterClick = false;
});
expects('the picker click left user_avatar unchanged -> personaPickerChangedThePersonaOnBothLegs fails', 'personaPickerChangedThePersonaOnBothLegs', leg => {
    leg.dom.personaPicker.userAvatarAfter = leg.dom.personaPicker.currentPersonaBefore;
    leg.dom.personaPicker.personaChanged = false;
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
// guard in a leg pair that reproduces the REAL state, and every FALSE guard must be named (the verifier enforces
// the second half).
//
// THE BASELINE FOR THIS CHECK IS THE MEASURED ONE, NOT THE IDEAL ONE. Two guards -- the gallery PAINT and the
// click that drives it -- are declared unproven with a cause that is identical on BOTH subjects (the pinned
// frontend's `initBackgrounds()` bindings are absent in this tree). A baseline where those guards pass would make
// the declaration look stale, but it would also be a baseline that contradicts five measured runs. So the leg
// pair below reproduces exactly that state, and the two cases then say what they are meant to say: nothing is
// declared that passes, and nothing that fails is undeclared.
{
    const measuredLeg = () => {
        const leg = faithfulLeg('gotavern');
        leg.dom.stagedBackgroundDriven = false;
        leg.dom.backgroundDriven.appliedBackgroundImage = 'url("http://127.0.0.1:1/backgrounds/__transparent.png")';
        leg.dom.backgroundDriven.selectedTileAfterClick = '__transparent.png';
        leg.dom.backgroundDriven.delegatedBgClickBound = false;
        leg.dom.backgroundDriven.handlerSelectors = ['[data-displayHelp]', '.character_select'];
        leg.dom.backgroundDriven.startupEvidence = { addBgButtonBound: false, bgTabHandlers: false };
        return leg;
    };
    const measured = compare({ gotavern: measuredLeg(), pinned: measuredLeg() });
    const declared = new Set(measured.declaredUnproven);
    const stale = [...declared].filter(name => measured.guards[name] === true);
    record('no unproven[] entry names a guard that passes', stale.length === 0, stale.join(', '));
    const undeclared = Object.entries(measured.guards).filter(([name, value]) => value !== true && !declared.has(name)).map(([name]) => name);
    record('every false guard is declared in unproven[]', undeclared.length === 0, undeclared.join(', '));
}

// ---- the probe's fixture path must not depend on the process's cwd --------------------------------
//
// Measured, run 40304309528: `run-against-pinned.mjs` spawns the probe with `cwd: tests/browser`, so a
// `../fixtures/real/card-a.png` relative path resolved one level short and BOTH asset legs died with
// `ENOENT: .../tests/fixtures/real/card-a.png`. The probe now resolves it from its own module directory. This
// case asserts the FILE EXISTS and that the probe's own resolution lands on it, without a browser: it checks the
// path from two different cwds, because a path that only works from one directory is the defect itself.
const hereDir = path.dirname(fileURLToPath(import.meta.url));
{
    const expected = path.join(hereDir, 'fixtures', 'real', 'card-a.png');
    record('the committed real card exists where the probe resolves it', existsSync(expected), expected);
    const source = readFileSync(path.join(hereDir, 'asset-probe.mjs'), 'utf8');
    const resolvesFromHere = /const REAL_CARD_RELATIVE = path\.join\(here, 'fixtures', 'real', 'card-a\.png'\);/.test(source);
    record('the probe resolves the card from its own module directory, not the cwd', resolvesFromHere, resolvesFromHere ? undefined : 'REAL_CARD_RELATIVE is not built from `here`');
    // The probe's own `here` is `tests/browser`; this reproduces its resolution without importing the probe (which
    // would launch a browser) and runs it under two cwds.
    const probe = `import path from 'node:path'; import fs from 'node:fs';
const here = ${JSON.stringify(hereDir)};
process.stdout.write(String(fs.existsSync(path.join(here, 'fixtures', 'real', 'card-a.png'))));`;
    const fromBrowserDir = execFileSync(process.execPath, ['-e', probe], { cwd: hereDir, encoding: 'utf8' });
    const fromRepoRoot = execFileSync(process.execPath, ['-e', probe], { cwd: path.resolve(hereDir, '..', '..'), encoding: 'utf8' });
    record('the card resolves from tests/browser AND from the repository root', fromBrowserDir === 'true' && fromRepoRoot === 'true', `cwd=tests/browser -> ${fromBrowserDir}, cwd=repo root -> ${fromRepoRoot}`);
}

const failed = results.filter(entry => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} case(s) behaved as required`);
if (failed.length > 0) {
    console.error(`DECORATION: ${failed.map(entry => entry.name).join(', ')}`);
    process.exit(1);
}
