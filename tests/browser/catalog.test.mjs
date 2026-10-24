// The browser catalogue's own contract, tested without a browser.
//
// Three things can go wrong with a source catalogue and none of them need a run to detect:
//
//   1. a catalogue ENTRY is incomplete -- no secret slot, no aiming mechanism, no capability row -- so a
//      drive built from it would reach the real provider or silently measure nothing;
//   2. an ARTEFACT names a source the catalogue does not have (or two sources claim one artefact), so a
//      committed comparison is checked against nothing, or against the wrong row;
//   3. the LEG-NAME patterns in tests/browser/.gitignore stop covering the names the harness actually
//      writes, so a re-record leaves 100-250 KB of untracked debris beside the gated artefact.
//
// Run: node --test tests/browser/catalog.test.mjs
// This file is also what the "show it RED" evidence in the PR body was produced with: add a bogus entry
// and the first subtest names it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, validateCatalog, sourceForArtifact, PINNED_ROUTE, PEER_CIRCUIT } from './sources.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

test('the catalogue is valid', () => {
    assert.deepEqual(validateCatalog(), []);
});

test('the validator itself rejects an incomplete entry (a passing validator that cannot fail is decoration)', () => {
    // Every one of these is a real way a row can be wrong, and each must be named. The omissions are
    // built by DELETING the key, not by assigning undefined: `'key' in object` is true for an explicit
    // undefined, so a test written the other way would pass against a validator that checks nothing.
    const withoutKey = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
    // A source that carries its peer NEITHER in custom_url nor in reverse_proxy: strip its seam and its
    // redirect and the only way either leg could reach the peer is the live provider.
    const seamOnly = SOURCES.find(entry => entry.probe.seams.length > 0 && !entry.probe.customUrl && !entry.probe.reverseProxy);
    assert.ok(seamOnly, 'expected a catalogued source aimed by seam and redirect alone');
    const cases = [
        [{ probe: withoutKey(SOURCES[0].probe, 'secretKey') }, 'probe.secretKey'],
        [{ probe: { ...seamOnly.probe, seams: [], redirectFrom: [] }, pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL }, 'can reach the real provider'],
        [{ capabilities: { ...SOURCES[0].capabilities, streaming: 'yes' } }, 'capabilities.streaming'],
        [{ evidence: { generation: null, streaming: null } }, 'no committed artefact'],
        [{ expectedBody: 'probe reply' }, 'expectation-shaped'],
        [{ driveSupported: false }, 'unproven reason'],
    ];
    for (const [patch, needle] of cases) {
        const problems = validateCatalog([{ ...SOURCES[0], ...patch }]);
        assert.ok(problems.length > 0, `a row with ${JSON.stringify(Object.keys(patch))} must be rejected`);
        assert.ok(problems.some(problem => problem.includes(needle)), `the rejection must name ${JSON.stringify(needle)}; got ${JSON.stringify(problems)}`);
    }
});

test('every catalogued source is complete enough to drive and to cite', () => {
    for (const source of SOURCES) {
        const where = `source ${source.id}`;
        // A SECRET SLOT: null is allowed (a keyless source), absent is not -- the probe writes the key
        // before the drive and an absent slot would throw at run time instead of here.
        assert.ok('secretKey' in source.probe, `${where}: no secret slot`);
        // AN AIMING MECHANISM on both legs, or the drive can reach the live network.
        const carriesPeer = source.probe.customUrl === true || source.probe.reverseProxy === true;
        if (carriesPeer) {
            assert.ok(source.pinnedRoute === PINNED_ROUTE.CUSTOM_URL || source.pinnedRoute === PINNED_ROUTE.REVERSE_PROXY,
                `${where}: carries the peer in the request, so its pinnedRoute must say so`);
        } else {
            assert.ok(source.probe.seams.length > 0, `${where}: no seam to aim the GoTavern leg`);
            assert.ok(source.probe.redirectFrom.length > 0, `${where}: no pinned origin to redirect`);
        }
        // A CAPABILITY ROW for every surface this lane records.
        for (const surface of ['generation', 'streaming', 'cancellation']) {
            assert.equal(typeof source.capabilities[surface], 'boolean', `${where}: capabilities.${surface} must be a boolean`);
        }
        // A GAP MUST BE STATED. A drivable surface with no artefact is a row nobody measured; it is
        // allowed, but only with the reason attached.
        const hasEvidence = Boolean(source.evidence.generation || source.evidence.streaming);
        if (!hasEvidence) {
            assert.equal(typeof source.unproven, 'string', `${where}: claims a drivable surface with no artefact and no reason`);
        }
        assert.equal(Object.values(PEER_CIRCUIT).includes(source.probe.peer.circuit), true, `${where}: unknown peer circuit`);
    }
});

test('every committed chat-completion artefact belongs to exactly one catalogued source', () => {
    const claimed = new Map();
    for (const source of SOURCES) {
        for (const surface of ['generation', 'streaming']) {
            const file = source.evidence?.[surface];
            if (!file) continue;
            assert.ok(existsSync(path.join(here, file)), `source ${source.id}: evidence.${surface} names ${file}, which is not in tests/browser`);
            assert.ok(!claimed.has(file), `${file} is claimed by both ${claimed.get(file)} and ${source.id}`);
            claimed.set(file, source.id);
            const back = sourceForArtifact(file);
            assert.equal(back?.source.id, source.id, `${file} does not map back to ${source.id}`);
            assert.equal(back?.surface, surface, `${file} maps back to the wrong surface`);
        }
    }
    // THE CONVERSE: an artefact that no row claims is an artefact no invariant runs against.
    const onDisk = readdirSync(here)
        .filter(name => /^generation-.*-comparison\.json$/.test(name) || /^streaming-.*-comparison\.json$/.test(name));
    for (const file of onDisk) {
        assert.ok(claimed.has(file), `${file} is committed but no catalogued source claims it -- add the row or delete the file`);
    }
});

// ---- .gitignore: the patterns must cover what the harness writes -------------------------------
// A minimal gitignore matcher: every pattern in this file is a basename glob (no `/`), which git
// matches at any depth, so a basename match is exactly git's behaviour here.
const globToRegExp = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);

const ignorePatterns = () => readFileSync(path.join(here, '.gitignore'), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
    .map(pattern => pattern.replace(/\/$/, ''));

const isIgnored = fileName => ignorePatterns().some(pattern => pattern.endsWith('/')
    ? fileName.startsWith(pattern)
    : globToRegExp(pattern).test(fileName));

test('the ignore patterns cover every leg name the committed artefacts record', () => {
    // THE REAL NAMES, read out of the committed artefacts' own `captures`/`inputs` fields: these are
    // what the harness wrote, not what someone imagined it would write.
    const recorded = new Set();
    for (const file of readdirSync(here).filter(name => name.endsWith('-comparison.json'))) {
        const artifact = JSON.parse(readFileSync(path.join(here, file), 'utf8'));
        for (const holder of [artifact.captures, artifact.inputs]) {
            for (const value of Object.values(holder ?? {})) {
                if (typeof value === 'string') recorded.add(path.basename(value));
            }
        }
    }
    assert.ok(recorded.size >= 10, `expected the committed artefacts to name their legs; found ${recorded.size}`);
    for (const leg of recorded) {
        assert.ok(isIgnored(leg), `the harness wrote ${leg} and tests/browser/.gitignore does not ignore it`);
    }
    // AND THE NAMES A NEXT RUN WILL PLAUSIBLY USE, per source, which is the case the old exact-name
    // list failed: a leg named after its source.
    for (const source of SOURCES.filter(entry => entry.evidence?.generation)) {
        for (const name of [
            `gen-${source.id}.json`, `gen-${source.id}-gotavern.json`, `gen-${source.id}-pinned.json`,
            `stream-${source.id}-gotavern.json`, `stream-${source.id}-pinned.json`,
            `cancel-${source.id}-gotavern.json`, `nonstream-${source.id}-pinned.json`,
        ]) {
            assert.ok(isIgnored(name), `a per-source leg named ${name} would escape the ignore list`);
        }
    }
    for (const name of ['startup-gotavern-3.json', 'data-domain-gotavern-3.json', 'dd3-g1.json', 'ext-lwb-B1-leg.json']) {
        assert.ok(isIgnored(name), `${name} would escape the ignore list`);
    }
    assert.ok(isIgnored('generation-probe-report.json'));
});

test('the ignore patterns never swallow a committed artefact', () => {
    const committed = readdirSync(here).filter(name => name.endsWith('-comparison.json'));
    assert.ok(committed.length >= 25, `expected the committed artefacts on disk; found ${committed.length}`);
    for (const file of committed) {
        assert.equal(isIgnored(file), false, `${file} is committed but tests/browser/.gitignore would ignore it`);
    }
});
