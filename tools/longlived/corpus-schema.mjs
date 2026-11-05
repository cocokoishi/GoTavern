// THE SHARED CORPUS-SCHEMA CONTRACT (alpha.15 lane E, §0.3).
//
// ONE schema, TWO generators. `internal/longlivedfixture/corpus_schema.go` emits this shape for the Go
// complex instance; `tools/build-longlived-corpus.mjs` emits the same shape for the browser/Node corpus.
// Any consumer can verify the tree it is about to drive against the schema (`verifyCorpusAgainstSchema`),
// and `compareCorpora` measures the two schemas against each other and names EVERY difference class.
//
// WHAT THIS IS NOT. A claim that the two corpora are identical. A schema describes a tree; it does not make
// two trees the same, and the comparison tool's `decision` field says so with file-set, count, feature and
// marker evidence rather than prose. "Identical" is only ever reported when every file's sha256 matches.
//
// THE SCHEMA (gotavern-corpus-schema v1):
//
//   schema, schemaVersion        the contract; consumers refuse anything else
//   generator, generatorVersion  which builder produced the tree (an identity, not an equality claim)
//   size, seed                   the generator's size label and seed
//   counts                       derived counts plus the generator's declared scenario counts; a verifier
//                                derives files/bytes/class counts from the tree and compares those
//   features                     named capability booleans (branches, swipes, sprites, regex keys, ...)
//   markers                      text markers a probe may search for (sorted arrays)
//   tree                         {sha256, files, bytes}; sha256 = sha256 over sorted "<sha256>  <path>\n"
//                                lines of every file except the governance manifests (manifest.json,
//                                corpus-schema.json), the same format the builder's treeDigest uses
//   files                        sorted inventory [{path, bytes, sha256, class}]
//
// DETERMINISM. Nothing here reads a clock, an environment variable or Math.random: a schema is a pure
// function of the tree bytes plus the values the generator declares, so two builds of the same input have
// byte-identical schema files. The classifier table below is the SAME one as the Go side; a disagreement is
// reported as `class-disagreement`/`class:<name>`, never silently resolved.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA_NAME = 'gotavern-corpus-schema';
export const SCHEMA_VERSION = 1;
export const GO_GENERATOR = 'internal/longlivedfixture';
export const JS_GENERATOR = 'tools/build-longlived-corpus.mjs';
export const SCHEMA_METADATA_NAMES = new Set(['manifest.json', 'corpus-schema.json']);

// ---------------------------------------------------------------------------------------------------------------
// CLASSIFIER -- keep byte-for-byte equivalent to internal/longlivedfixture/corpus_schema.go.
// ---------------------------------------------------------------------------------------------------------------

export function classifyCorpusPath(relative, body) {
    const normalised = relative.replaceAll('\\', '/');
    if (normalised === 'config.yaml') return 'config';
    if (normalised === 'manifest.json' || normalised === 'corpus-schema.json') return 'system';
    if (normalised === 'content.log') return 'contentLog';
    if (normalised.startsWith('public/characters/')) return 'legacy';
    const userPrefix = 'default-user/';
    if (!normalised.startsWith(userPrefix)) return unknownOrBinary(normalised, body, 'unknown');
    const rest = normalised.slice(userPrefix.length);
    if (rest === 'settings.json') return 'settings';
    if (rest === 'secrets.json') return 'secrets';
    if (rest === 'content.log') return 'contentLog';
    if (rest.startsWith('stats/')) return 'stats';
    if (rest.startsWith('characters/')) return rest.split('/').length >= 3 ? 'characterSprites' : 'characters';
    if (rest.startsWith('chats/')) return 'chats';
    if (rest.startsWith('group chats/')) return 'groupChats';
    if (rest.startsWith('groups/')) return 'groups';
    if (rest.startsWith('worlds/')) return 'worlds';
    if (rest.startsWith('OpenAI Settings/')) return 'presets';
    if (rest.startsWith('TextGen Settings/')) return 'textPresets';
    if (rest.startsWith('themes/')) return 'themes';
    if (rest.startsWith('QuickReplies/')) return 'quickReplies';
    if (rest.startsWith('movingUI/')) return 'movingUI';
    if (rest.startsWith('backgrounds/')) return 'backgrounds';
    if (rest.startsWith('User Avatars/')) return 'avatars';
    if (rest.startsWith('assets/')) return 'assets';
    if (rest.startsWith('user/files/')) return 'userFiles';
    if (rest.startsWith('user/images/')) return 'userImages';
    if (rest.startsWith('extensions/')) return 'extensionState';
    if (rest.startsWith('regex/')) return 'regex';
    if (rest.startsWith('thumbnails/')) return 'thumbnails';
    if (rest.startsWith('backups/chat_')) return 'chatBackups';
    if (rest.startsWith('backups/')) return 'system';
    return unknownOrBinary(rest, body, 'unknown');
}

function unknownOrBinary(relative, body, fallback) {
    const bytes = body instanceof Uint8Array ? body : Buffer.from(body);
    let validUtf8 = true;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        validUtf8 = false;
    }
    if (!validUtf8 || bytes.includes(0)) return 'binary';
    if (path.extname(relative) === '.bin') return 'binary';
    return fallback;
}

// ---------------------------------------------------------------------------------------------------------------
// WALK / DIGEST.
// ---------------------------------------------------------------------------------------------------------------

export function sha256(body) {
    return createHash('sha256').update(body).digest('hex');
}

export function normaliseRelative(relative) {
    return relative.split(path.sep).join('/');
}

/**
 * Walk a tree exactly the way the Go schema walker does: regular files only, slash-separated paths relative
 * to the root, governance manifests at the ROOT excluded from the inventory and the digest, sorted by path.
 */
export async function walkCorpus(root) {
    const files = [];
    const walk = async directory => {
        const children = await fs.readdir(directory, { withFileTypes: true });
        for (const child of children) {
            const full = path.join(directory, child.name);
            if (child.isDirectory()) {
                await walk(full);
                continue;
            }
            if (!child.isFile()) continue;
            const relative = normaliseRelative(path.relative(root, full));
            if (!relative.includes('/') && SCHEMA_METADATA_NAMES.has(relative)) continue;
            const body = await fs.readFile(full);
            files.push({
                path: relative,
                bytes: body.length,
                sha256: sha256(body),
                class: classifyCorpusPath(relative, body),
            });
        }
    };
    await walk(root);
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return files;
}

export function treeIdentity(files) {
    const digest = createHash('sha256');
    let bytes = 0;
    for (const file of files) {
        digest.update(`${file.sha256}  ${file.path}\n`);
        bytes += file.bytes;
    }
    return { sha256: digest.digest('hex'), files: files.length, bytes };
}

export function classCounts(files) {
    const counts = {};
    for (const file of files) counts[file.class] = (counts[file.class] ?? 0) + 1;
    return counts;
}

// ---------------------------------------------------------------------------------------------------------------
// SCHEMA BUILDING AND VALIDATION.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Build a schema from a tree on disk. `counts`, `features` and `markers` are the generator's declaration for
 * fields a tree walk cannot derive (scenario counts, capability flags, text markers); files/bytes/class
 * counts and the tree digest are DERIVED from the walk and overwrite anything the caller supplied under
 * those keys. That split is what makes "the manifest describes the tree" checkable.
 */
export async function buildSchemaFromTree({ root, generator, generatorVersion, size, seed, counts = {}, features = {}, markers = {} }) {
    const files = await walkCorpus(root);
    const identity = treeIdentity(files);
    const classes = classCounts(files);
    const derivedCounts = { ...counts, files: identity.files, bytes: identity.bytes };
    for (const [name, count] of Object.entries(classes)) derivedCounts[`class.${name}`] = count;
    // Inventory-backed counts are DERIVED, never declared, and use the same names on both generators so the
    // comparison tool compares like with like. The declared duplicates a generator's manifest carries
    // (quickreplies, worldbooks, swipedMessages, ...) are not passed in by the builder for this reason.
    derivedCounts.unknownFiles = (classes.unknown ?? 0) + (classes.binary ?? 0);
    derivedCounts.legacyAssets = classes.legacy ?? 0;
    derivedCounts.backups = classes.chatBackups ?? 0;
    derivedCounts.binaryFiles = classes.binary ?? 0;
    derivedCounts.contentLog = classes.contentLog ?? 0;
    // `features` may be an object or a function of the walked inventory: a generator that can only decide a
    // capability from the FILES IT WROTE (an unknown-extension file, a backup) derives it here instead of
    // declaring a value it has not measured.
    const resolvedFeatures = typeof features === 'function' ? features(files, classes) : { ...features };
    return {
        schema: SCHEMA_NAME,
        schemaVersion: SCHEMA_VERSION,
        generator,
        generatorVersion,
        size,
        seed,
        counts: derivedCounts,
        features: resolvedFeatures,
        markers: Object.fromEntries(Object.entries(markers).map(([key, values]) => [key, [...values].sort()])),
        tree: identity,
        files,
    };
}

export function schemaBytes(schema) {
    return `${JSON.stringify(schema, null, 2)}\n`;
}

export async function writeSchema(target, schema) {
    await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
    await fs.writeFile(target, schemaBytes(schema), 'utf8');
}

export async function loadSchema(target) {
    const schema = JSON.parse(await fs.readFile(target, 'utf8'));
    const errors = validateSchema(schema);
    if (errors.length > 0) throw new Error(`invalid corpus schema ${target}: ${errors.join('; ')}`);
    return schema;
}

/** validateSchema returns named shape errors; an empty array means the schema is usable. */
export function validateSchema(schema) {
    const errors = [];
    if (!schema || typeof schema !== 'object') return ['schema-not-an-object'];
    if (schema.schema !== SCHEMA_NAME) errors.push(`schema-name:${schema.schema}`);
    if (schema.schemaVersion !== SCHEMA_VERSION) errors.push(`schema-version:${schema.schemaVersion}`);
    if (!Array.isArray(schema.files) || schema.files.length === 0) errors.push('files-missing');
    if (!schema.tree || typeof schema.tree.sha256 !== 'string' || schema.tree.sha256.length !== 64) errors.push('tree-digest-missing');
    const seen = new Set();
    for (const file of schema.files ?? []) {
        if (typeof file.path !== 'string' || file.path === '') {
            errors.push('file-path-empty');
            continue;
        }
        if (path.isAbsolute(file.path) || file.path.startsWith('../') || file.path.includes('\\')) errors.push(`file-path-unsafe:${file.path}`);
        if (seen.has(file.path)) errors.push(`file-path-duplicate:${file.path}`);
        seen.add(file.path);
        if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) errors.push(`file-sha256-shape:${file.path}`);
        if (typeof file.bytes !== 'number' || file.bytes < 0) errors.push(`file-bytes-shape:${file.path}`);
        if (typeof file.class !== 'string' || file.class === '') errors.push(`file-class-missing:${file.path}`);
    }
    const sorted = [...(schema.files ?? [])].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    if (schema.files && sorted.some((file, index) => file.path !== schema.files[index].path)) errors.push('files-not-sorted');
    for (const metadataName of SCHEMA_METADATA_NAMES) {
        if (seen.has(metadataName)) errors.push(`governance-manifest-in-inventory:${metadataName}`);
    }
    return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// TREE VERIFICATION -- the consumer-side gate. Every check has a stable name; the Go teeth tests assert the
// name, not a prose message.
// ---------------------------------------------------------------------------------------------------------------

export async function verifyCorpusAgainstSchema({ corpus, schema }) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: ok === true, detail: detail ?? null });
    const shapeErrors = validateSchema(schema);
    add('schema-valid', shapeErrors.length === 0, shapeErrors.length ? shapeErrors.slice(0, 10) : null);

    const files = await walkCorpus(corpus);
    const byPath = new Map(files.map(file => [file.path, file]));
    const expected = new Map((schema.files ?? []).map(file => [file.path, file]));

    const missing = [...expected.keys()].filter(relative => !byPath.has(relative)).sort();
    add('inventory-no-missing-files', missing.length === 0, missing.slice(0, 10));
    const extra = [...byPath.keys()].filter(relative => !expected.has(relative)).sort();
    add('inventory-no-extra-files', extra.length === 0, extra.slice(0, 10));

    const changed = [];
    const classDisagreements = [];
    for (const [relative, wanted] of expected) {
        const found = byPath.get(relative);
        if (!found) continue;
        if (found.sha256 !== wanted.sha256) changed.push(relative);
        if (found.class !== wanted.class) classDisagreements.push({ path: relative, schema: wanted.class, tree: found.class });
    }
    add('file-sha256', changed.length === 0, changed.slice(0, 10));
    add('class-agreement', classDisagreements.length === 0, classDisagreements.slice(0, 10));

    const identity = treeIdentity(files);
    add('tree-digest-equals-schema', identity.sha256 === schema.tree?.sha256, {
        schema: schema.tree?.sha256 ?? null,
        tree: identity.sha256,
    });
    add('count-files-matches-inventory', identity.files === schema.tree?.files && identity.files === (schema.counts?.files ?? identity.files), {
        schemaTree: schema.tree?.files ?? null,
        schemaCounts: schema.counts?.files ?? null,
        tree: identity.files,
    });
    add('count-bytes-matches-inventory', identity.bytes === schema.tree?.bytes, { schema: schema.tree?.bytes ?? null, tree: identity.bytes });

    const treeClasses = classCounts(files);
    const schemaClasses = {};
    for (const [name, count] of Object.entries(schema.counts ?? {})) {
        if (name.startsWith('class.')) schemaClasses[name.slice('class.'.length)] = count;
    }
    const classDiffs = [];
    for (const name of new Set([...Object.keys(treeClasses), ...Object.keys(schemaClasses)])) {
        if ((treeClasses[name] ?? 0) !== (schemaClasses[name] ?? 0)) {
            classDiffs.push({ class: name, schema: schemaClasses[name] ?? 0, tree: treeClasses[name] ?? 0 });
        }
    }
    add('class-counts-match-schema', classDiffs.length === 0, classDiffs.slice(0, 10));

    const ok = checks.every(check => check.ok);
    return {
        schema: { name: schema.schema, version: schema.schemaVersion, generator: schema.generator, size: schema.size, seed: schema.seed },
        corpus: { root: path.resolve(corpus), files: identity.files, bytes: identity.bytes, treeSha256: identity.sha256 },
        checks,
        failed: checks.filter(check => !check.ok).map(check => check.name),
        ok,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// STRUCTURAL COMPARISON -- the measured answer to "can one corpus serve both?".
// ---------------------------------------------------------------------------------------------------------------

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

function sizeProfile(files) {
    const byClass = {};
    for (const file of files) {
        const entry = (byClass[file.class] ??= { count: 0, bytes: 0, largest: 0, sizes: [] });
        entry.count += 1;
        entry.bytes += file.bytes;
        entry.largest = Math.max(entry.largest, file.bytes);
        entry.sizes.push(file.bytes);
    }
    const profile = {};
    for (const [name, entry] of Object.entries(byClass)) {
        profile[name] = { count: entry.count, bytes: entry.bytes, largest: entry.largest, median: median(entry.sizes) };
    }
    return profile;
}

/**
 * compareCorpora is the §0.3 measurement. It never decides "identical" from a digest alone: `byteIdentical`
 * requires the same path set and equal sha256 for every path. Every difference is a named class with its
 * measured evidence, so a report can say WHY two corpora exist instead of asserting it.
 */
export function compareCorpora(left, right) {
    const leftByPath = new Map(left.files.map(file => [file.path, file]));
    const rightByPath = new Map(right.files.map(file => [file.path, file]));
    const onlyLeft = [...leftByPath.keys()].filter(relative => !rightByPath.has(relative)).sort();
    const onlyRight = [...rightByPath.keys()].filter(relative => !leftByPath.has(relative)).sort();
    const changed = [];
    const classDisagreements = [];
    for (const [relative, leftFile] of leftByPath) {
        const rightFile = rightByPath.get(relative);
        if (!rightFile) continue;
        if (leftFile.sha256 !== rightFile.sha256) changed.push(relative);
        if (leftFile.class !== rightFile.class) classDisagreements.push({ path: relative, left: leftFile.class, right: rightFile.class });
    }
    const sharedPaths = [...leftByPath.keys()].filter(relative => rightByPath.has(relative));
    const identicalPaths = sharedPaths.filter(relative => leftByPath.get(relative).sha256 === rightByPath.get(relative).sha256);
    const byteIdentical = onlyLeft.length === 0 && onlyRight.length === 0 && changed.length === 0;

    const leftClasses = classCounts(left.files);
    const rightClasses = classCounts(right.files);
    const classTable = [];
    for (const name of [...new Set([...Object.keys(leftClasses), ...Object.keys(rightClasses)])].sort()) {
        classTable.push({
            class: name,
            left: leftClasses[name] ?? 0,
            right: rightClasses[name] ?? 0,
            delta: (rightClasses[name] ?? 0) - (leftClasses[name] ?? 0),
        });
    }

    // Only NUMERIC counts are compared as counts. A generator's manifest may also carry declared string
    // arrays (legacyUnknownSettingsKeys); those are declarations, not measurements, and comparing their
    // lengths as if they were counts is the kind of false precision this tool exists to avoid.
    const countKeys = [...new Set([...Object.keys(left.counts ?? {}), ...Object.keys(right.counts ?? {})])]
        .filter(key => !key.startsWith('class.'))
        .filter(key => typeof left.counts?.[key] === 'number' || typeof right.counts?.[key] === 'number')
        .sort();
    const countTable = countKeys.map(key => {
        const leftValue = typeof left.counts?.[key] === 'number' ? left.counts[key] : null;
        const rightValue = typeof right.counts?.[key] === 'number' ? right.counts[key] : null;
        return { count: key, left: leftValue, right: rightValue, delta: (rightValue ?? 0) - (leftValue ?? 0) };
    });
    const countDifferences = countTable.filter(row => row.left !== row.right);

    const featureKeys = [...new Set([...Object.keys(left.features ?? {}), ...Object.keys(right.features ?? {})])].sort();
    const featureTable = featureKeys.map(key => ({ feature: key, left: left.features?.[key] ?? null, right: right.features?.[key] ?? null, equal: (left.features?.[key] ?? null) === (right.features?.[key] ?? null) }));
    const featureDifferences = featureTable.filter(row => !row.equal);

    const markerKeys = [...new Set([...Object.keys(left.markers ?? {}), ...Object.keys(right.markers ?? {})])].sort();
    const markerTable = markerKeys.map(key => {
        const leftValues = left.markers?.[key] ?? [];
        const rightValues = right.markers?.[key] ?? [];
        return {
            marker: key,
            leftCount: leftValues.length,
            rightCount: rightValues.length,
            equal: JSON.stringify(leftValues) === JSON.stringify(rightValues),
            leftSample: leftValues.slice(0, 4),
            rightSample: rightValues.slice(0, 4),
        };
    });
    const markerDifferences = markerTable.filter(row => !row.equal);

    const leftSizes = sizeProfile(left.files);
    const rightSizes = sizeProfile(right.files);
    const sizeTable = [...new Set([...Object.keys(leftSizes), ...Object.keys(rightSizes)])].sort().map(name => ({
        class: name,
        left: leftSizes[name] ?? null,
        right: rightSizes[name] ?? null,
    }));

    const differenceClasses = [];
    differenceClasses.push({ name: 'generator-identity', left: left.generator, right: right.generator, detail: 'different builders; the trees cannot be claimed identical from the schema alone' });
    if (left.size !== right.size || left.seed !== right.seed) {
        differenceClasses.push({ name: 'size-or-seed', left: `${left.size}/${left.seed}`, right: `${right.size}/${right.seed}` });
    }
    if (onlyLeft.length || onlyRight.length) {
        differenceClasses.push({ name: 'file-set', leftOnly: onlyLeft.length, rightOnly: onlyRight.length, detail: { leftOnly: onlyLeft.slice(0, 12), rightOnly: onlyRight.slice(0, 12) } });
    }
    if (changed.length) differenceClasses.push({ name: 'changed-file-bytes', paths: changed.slice(0, 12), count: changed.length });
    for (const row of countDifferences) differenceClasses.push({ name: `count:${row.count}`, left: row.left, right: row.right });
    for (const row of featureDifferences) differenceClasses.push({ name: `feature:${row.feature}`, left: row.left, right: row.right });
    for (const row of markerDifferences) differenceClasses.push({ name: `marker:${row.marker}`, left: row.leftCount, right: row.rightCount });
    for (const row of classTable.filter(row => row.left !== row.right)) differenceClasses.push({ name: `class:${row.class}`, left: row.left, right: row.right });
    for (const row of classDisagreements) differenceClasses.push({ name: `class-disagreement:${row.path}`, left: row.left, right: row.right });

    const coverageOnlyLeft = featureDifferences.filter(row => row.left === true && row.right !== true).map(row => row.feature);
    const coverageOnlyRight = featureDifferences.filter(row => row.right === true && row.left !== true).map(row => row.feature);
    const classesOnlyLeft = classTable.filter(row => row.left > 0 && row.right === 0).map(row => row.class);
    const classesOnlyRight = classTable.filter(row => row.right > 0 && row.left === 0).map(row => row.class);
    const separateCorporaJustified = !byteIdentical && (onlyLeft.length > 0 || onlyRight.length > 0 || coverageOnlyLeft.length > 0 || coverageOnlyRight.length > 0 || classesOnlyLeft.length > 0 || classesOnlyRight.length > 0);
    const justifyingClasses = differenceClasses
        .map(entry => entry.name)
        .filter(name => !name.startsWith('generator-identity') && !name.startsWith('size-or-seed'));

    return {
        schema: { name: left.schema, version: left.schemaVersion, shared: left.schema === right.schema && left.schemaVersion === right.schemaVersion },
        left: { generator: left.generator, size: left.size, seed: left.seed, files: left.tree.files, bytes: left.tree.bytes, treeSha256: left.tree.sha256 },
        right: { generator: right.generator, size: right.size, seed: right.seed, files: right.tree.files, bytes: right.tree.bytes, treeSha256: right.tree.sha256 },
        byteIdentical,
        identicalPaths: identicalPaths.length,
        sharedPaths: sharedPaths.length,
        onlyLeft,
        onlyRight,
        changedPaths: changed,
        classTable,
        countTable,
        countDifferences,
        featureTable,
        featureDifferences,
        markerTable,
        markerDifferences,
        sizeTable,
        differenceClasses,
        coverage: {
            featuresOnlyLeft: coverageOnlyLeft,
            featuresOnlyRight: coverageOnlyRight,
            classesOnlyLeft,
            classesOnlyRight,
        },
        decision: byteIdentical ? 'ONE_CORPUS_BYTE_IDENTICAL' : 'TWO_CORPORA_SHARED_SCHEMA',
        separateCorporaJustified,
        justifyingClasses,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// MARKDOWN RENDERING -- the docs tables are generated from the measured report, never typed by hand.
// ---------------------------------------------------------------------------------------------------------------

export function renderComparisonMarkdown(report) {
    const lines = [];
    lines.push('| fact | left (Go complex) | right (JS long-lived) |');
    lines.push('|---|---|---|');
    lines.push(`| generator | \`${report.left.generator}\` | \`${report.right.generator}\` |`);
    lines.push(`| size / seed | ${report.left.size} / ${report.left.seed} | ${report.right.size} / ${report.right.seed} |`);
    lines.push(`| files | ${report.left.files} | ${report.right.files} |`);
    lines.push(`| bytes | ${report.left.bytes} | ${report.right.bytes} |`);
    lines.push(`| tree sha256 | \`${report.left.treeSha256.slice(0, 16)}…\` | \`${report.right.treeSha256.slice(0, 16)}…\` |`);
    lines.push(`| byte-identical paths | ${report.identicalPaths} of ${report.sharedPaths} shared | |`);
    lines.push('');
    lines.push('| class | Go files | JS files | delta |');
    lines.push('|---|---|---|---|');
    for (const row of report.classTable) lines.push(`| \`${row.class}\` | ${row.left} | ${row.right} | ${row.delta} |`);
    lines.push('');
    lines.push('| scenario count | Go | JS | delta |');
    lines.push('|---|---|---|---|');
    for (const row of report.countTable.filter(row => ['characters', 'chats', 'messages', 'branches', 'swipes', 'groups', 'worlds', 'worldEntries', 'presets', 'textPresets', 'unknownFiles', 'binaryFiles', 'legacyAssets'].includes(row.count))) {
        lines.push(`| ${row.count} | ${row.left ?? '—'} | ${row.right ?? '—'} | ${row.delta} |`);
    }
    lines.push('');
    lines.push('| feature | Go | JS | equal |');
    lines.push('|---|---|---|---|');
    for (const row of report.featureTable) lines.push(`| \`${row.feature}\` | ${row.left ?? '—'} | ${row.right ?? '—'} | ${row.equal ? 'yes' : '**no**'} |`);
    lines.push('');
    lines.push(`**Decision:** \`${report.decision}\`; \`byteIdentical: ${report.byteIdentical}\`; \`separateCorporaJustified: ${report.separateCorporaJustified}\`; ${report.differenceClasses.length} measured difference class(es).`);
    lines.push('');
    lines.push('| difference class | measured evidence |');
    lines.push('|---|---|');
    for (const entry of report.differenceClasses) {
        const evidence = JSON.stringify({ left: entry.left, right: entry.right, leftOnly: entry.leftOnly, rightOnly: entry.rightOnly, ...(entry.detail && typeof entry.detail === 'object' ? {} : { detail: entry.detail }) }).slice(0, 220);
        lines.push(`| \`${entry.name}\` | ${evidence.replaceAll('|', '\\|')} |`);
    }
    return `${lines.join('\n')}\n`;
}
