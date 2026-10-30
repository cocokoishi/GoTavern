// THE SYNTHETIC THIRD-PARTY EXTENSION THIS SURFACE INSTALLS, AND THE THREE DIRECTORY LAYOUTS IT CAN INSTALL IT IN.
//
// WHY A SYNTHETIC EXTENSION AND NOT A CANARY. The 酒馆助手 / LittleWhiteBox legs prove the DEEP path (iframe, bridge,
// generation). The half they do not cover is the ordinary one: a plain installed extension, whose manifest, module,
// stylesheet, locale file and a SECOND-LEVEL script must each be SERVED correctly. A host that answers any of them with
// the wrong content type or the wrong bytes makes the extension appear dead in the UI with no error a user can act on
// (a `<script type="module">` fed `text/html` fails with "Unexpected token '<'"), so the observable this fixture exists
// for is (status, content-type, bytes) at a URL the PINNED FRONTEND ITSELF builds.
//
// THE URL SHAPES ARE DERIVED FROM PINNED SOURCE, NOT FROM MEMORY. Every path below is justified by a pinned line, and
// the probe records the justification beside the URL it fetched:
//
//   /api/extensions/discover                       public/scripts/extensions.js:300
//   .../manifest.json                              public/scripts/extensions.js:543
//   .../<manifest.js>                              public/scripts/extensions.js:819 (script tag) and :434 (dynamic import)
//   .../<manifest.css>                             public/scripts/extensions.js:787 (link rel=stylesheet)
//   .../<manifest.i18n[locale]>                    public/scripts/extensions.js:862
//   .../scripts/nested-module.js                   the module the entry point imports, resolved by the browser against the
//                                                  entry URL the script tag above uses (a second path level)
//
// and the MOUNT that answers them is pinned `src/users.js:1219`
//   router.use('/scripts/extensions/third-party/*', extensionsEnabledFeatureGuard,
//              createExtensionsRouteHandler(req => req.user.directories.extensions));
// with the user directory at `<DATA_ROOT>/<handle>/extensions` (`src/constants.js:37`, `src/users.js:683-696`), the
// feature guard answering 404 when `extensions.enabled` is false (`src/endpoints/extensions.js:72-79`), and the handler
// answering local file -> global fallback -> `sendStatus(404)` (`src/users.js:1092-1120`, the 404 at `:1115`).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// THE DIRECTORY NAME IS THE SAME ON BOTH SUBJECTS, so the URLs derived in each leg are comparable byte for byte; the
// per-subject discriminator below travels in a FILE's bytes, not in the path.
export const EXTENSION_DIR = 'gotavern-asset-probe';
// A second extension that is LISTED by discovery and has NO module: the negative case, where a user sees an extension
// in the list and nothing loads. `manifest.json` is present, `index.js` deliberately is not.
export const MISSING_MODULE_DIR = 'gotavern-asset-probe-no-module';

export const MARKER_PREFIX = 'GPT_ASSET_PROBE_MARKER';

const marker = name => `${MARKER_PREFIX}_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

// The entry module IMPORTS the nested module and references the stylesheet + nested data, so a real page's module graph
// fetches them; the probe fetches the same URLs directly because it is measuring SERVING, not execution (the canary
// legs own execution). The import specifier is relative, which is what makes the resolved URL a second-level path.
const ENTRY_MODULE = `// ${marker('entry')} main
import { probeValue } from './scripts/nested-module.js';

export const entry = { ${marker('entry')}: true, nested: probeValue, nestedModule: './scripts/nested-module.js' };

export async function activate() {
    // The frontend calls this hook after the module loads (public/scripts/extensions.js:429-445). It is not executed by
    // this surface -- the canary legs own execution -- and it must not reach the network if some future driver runs it.
    return entry;
}
`;

const NESTED_MODULE = `// ${marker('nested')} second-level module
export const probeValue = { ${marker('nested')}: true, level: 2 };

export function describe() {
    return { ${marker('nested')}: 'served from a nested directory' };
}
`;

const NESTED_DATA = JSON.stringify({ marker: marker('nested-data'), level: 2, bytes: 'asset served from scripts/' }, null, 2) + '\n';

const STYLESHEET = `/* ${marker('stylesheet')} */
.${EXTENSION_DIR} {
    /* the stylesheet's own bytes, so a wrong document served here is visible */
    --probe-marker: "${marker('stylesheet')}";
    color: #123456;
}
`;

const LOCALE = JSON.stringify({ translation: { 'asset probe': marker('locale') } }, null, 2) + '\n';

export const MANIFEST = {
    display_name: 'GoTavern Asset Probe',
    loading_order: 100,
    requires: [],
    optional: [],
    js: 'index.js',
    css: 'style.css',
    author: 'GoTavern extension-assets surface',
    version: '1.0.0',
    homePage: 'about:blank',
    i18n: { 'en-uk': 'i18n/en-uk.json' },
};

// THE FILES, keyed by their path UNDER the extension directory. `kind` is only used to name the URL class in a failure
// message; the comparison is on bytes, so a kind cannot make a difference pass.
export const FIXTURE_FILES = {
    'manifest.json': { content: `${JSON.stringify(MANIFEST, null, 2)}\n`, kind: 'manifest' },
    'index.js': { content: ENTRY_MODULE, kind: 'entry-module' },
    'style.css': { content: STYLESHEET, kind: 'stylesheet' },
    'scripts/nested-module.js': { content: NESTED_MODULE, kind: 'nested-module' },
    'scripts/nested-data.json': { content: NESTED_DATA, kind: 'nested-data' },
    'i18n/en-uk.json': { content: LOCALE, kind: 'locale' },
};

// The file whose CONTENT is this leg's identity. It is installed into the extension directory and then FETCHED THROUGH
// THE SUBJECT, so the recorded discriminator is a byte string the subject itself served -- not a field the harness wrote
// into its own report. The comparator requires the two legs' served discriminators to DIFFER (rule 50: a harness whose
// two artefacts cannot be told apart is not evidence) and excludes this URL from the byte-equality guards, by name.
export const DISCRIMINATOR_FILE = 'leg-discriminator.js';

export const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * The URL set the pinned frontend builds for one installed extension, with the pinned line that justifies each.
 * `name` is the discovery name, which pinned builds as `third-party/<folder>` (`src/endpoints/extensions.js:518`).
 */
export function urlsFor({ name = `third-party/${EXTENSION_DIR}`, manifest = MANIFEST } = {}) {
    return [
        { path: `/scripts/extensions/${name}/manifest.json`, class: 'manifest', justification: 'public/scripts/extensions.js:543' },
        { path: `/scripts/extensions/${name}/${manifest.js}`, class: 'entry-module', justification: 'public/scripts/extensions.js:819 and :434' },
        { path: `/scripts/extensions/${name}/${manifest.css}`, class: 'stylesheet', justification: 'public/scripts/extensions.js:787' },
        { path: `/scripts/extensions/${name}/${manifest.i18n['en-uk']}`, class: 'locale', justification: 'public/scripts/extensions.js:862' },
        { path: `/scripts/extensions/${name}/scripts/nested-module.js`, class: 'nested-module', justification: 'the entry module\'s own import, resolved against the URL at :819 (a second path level)' },
        { path: `/scripts/extensions/${name}/scripts/nested-data.json`, class: 'nested-data', justification: 'a second-level data asset beside the nested module, same directory join as :819' },
    ];
}

/**
 * Write the fixture into `dataRoot`'s user extensions directory.
 *
 * `layout: 'flat'` is a correct install: `<extensions>/<dir>/<file>`.
 * `layout: 'deep'` is the SAME files one directory deeper: `<extensions>/nested/<dir>/<file>`. Discovery lists immediate
 * subdirectories only (`src/endpoints/extensions.js:514-518`), so no extension is listed and every URL the probe derived
 * from the flat layout answers 404 -- the "installed to the wrong place" failure, which is what the teeth run uses.
 */
export function installFixture({ dataRoot, layout = 'flat', discriminator = null, omitModule = false }) {
    const userRoot = path.join(dataRoot, 'default-user');
    const extensionsRoot = path.join(userRoot, 'extensions');
    const parent = layout === 'deep' ? path.join(extensionsRoot, 'nested') : extensionsRoot;
    const extensionRoot = path.join(parent, EXTENSION_DIR);
    // AN INSTALL IS A WHOLE-DIRECTORY OPERATION, so every directory this fixture owns is REMOVED FIRST. Without this, a
    // leg re-run over a root that already holds a FLAT install leaves those files in place, and the 'deep' layout
    // mutation then changes nothing observable -- measured 2026-10-29: the deep stage's comparator came back with ONE red
    // guard instead of the twenty-six a real one-directory-deeper install produces, because the flat copy was still
    // being served. A fixture that cannot express the mutation it is named for is not evidence.
    for (const owned of [
        path.join(extensionsRoot, EXTENSION_DIR),
        path.join(extensionsRoot, 'nested', EXTENSION_DIR),
        path.join(extensionsRoot, MISSING_MODULE_DIR),
    ]) {
        fs.rmSync(owned, { recursive: true, force: true });
    }
    const written = {};
    const writeFile = (relativePath, content) => {
        const target = path.join(extensionRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const bytes = Buffer.from(content, 'utf8');
        fs.writeFileSync(target, bytes);
        written[relativePath.split(path.sep).join('/')] = { bytes: bytes.length, sha256: sha256(bytes) };
    };
    for (const [relativePath, entry] of Object.entries(FIXTURE_FILES)) {
        if (omitModule && relativePath === MANIFEST.js) continue;
        writeFile(relativePath, entry.content);
    }
    if (typeof discriminator === 'string' && discriminator.length > 0) {
        writeFile(DISCRIMINATOR_FILE, `// ${marker('discriminator')}\nwindow.__GOTAVERN_ASSET_PROBE_LEG = ${JSON.stringify(discriminator)};\n`);
    }

    // THE NEGATIVE EXTENSION: manifest present, module absent. It is a separate folder because discovery skips a folder
    // with no manifest (`src/endpoints/extensions.js:503-510`), and the point is that this one IS listed.
    const missingRoot = path.join(extensionsRoot, MISSING_MODULE_DIR);
    fs.mkdirSync(missingRoot, { recursive: true });
    const missingManifest = Buffer.from(`${JSON.stringify({ ...MANIFEST, display_name: 'GoTavern Asset Probe (module missing)' }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(missingRoot, 'manifest.json'), missingManifest);
    const staleModule = path.join(missingRoot, MANIFEST.js);
    if (fs.existsSync(staleModule)) fs.rmSync(staleModule);

    return {
        layout,
        extensionsRoot,
        extensionRoot,
        missingModuleRoot: missingRoot,
        written,
        discriminator,
        missingManifest: { bytes: missingManifest.length, sha256: sha256(missingManifest) },
        urls: urlsFor(),
    };
}

export function serveUrlPathFor(urlPath) {
    return urlPath;
}
