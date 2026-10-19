#!/usr/bin/env node
// Generate route and configuration inventories from a pinned SillyTavern tree.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PINNED_VERSION = '1.19.0';
const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const outputRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/generate-upstream-inventories.mjs <pinned-source> <gotavern-root>');
    process.exit(2);
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);
const sourceChanges = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: sourceRoot, encoding: 'utf8' });
if (sourceChanges.trim()) throw new Error('upstream has tracked local changes; refusing to inventory a modified oracle');

const require = createRequire(import.meta.url);
const espree = require('espree');
const yaml = require('yaml');
const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head']);

function apiStatusKey(method, fullPath, file, line) {
    return [method, fullPath, file, line].join('\0');
}

function readExistingApiStatuses() {
    let content;
    try {
        content = readFileSync(path.join(outputRoot, 'docs', 'api-inventory.md'), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return { routes: new Map(), redirects: new Map() };
        throw error;
    }

    const routes = new Map();
    const redirects = new Map();
    for (const line of content.split(/\r?\n/)) {
        const route = line.match(/^\| ([A-Z]+) \| `([^`]+)` \| \[([^:\]]+):(\d+)\]\([^)]+\) \| (.*) \|$/);
        if (route) {
            routes.set(apiStatusKey(route[1], route[2], route[3], route[4]), route[5]);
            continue;
        }
        const redirect = line.match(/^\| `([^`]+)` \| `([^`]+)` \| \[([^:\]]+):(\d+)\]\([^)]+\) \| (.*) \|$/);
        if (redirect) {
            redirects.set(apiStatusKey(redirect[1], redirect[2], redirect[3], redirect[4]), redirect[5]);
        }
    }
    return { routes, redirects };
}

function read(relative) {
    return readFileSync(path.join(sourceRoot, relative), 'utf8');
}

function walk(relative) {
    const absolute = path.join(sourceRoot, relative);
    const output = [];
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) output.push(...walk(name));
        else if (entry.isFile() && entry.name.endsWith('.js')) output.push(name.replaceAll(path.sep, '/'));
    }
    return output;
}

function parse(relative) {
    const source = read(relative);
    return { source, tree: espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true }) };
}

function visit(node, callback) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') callback(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
        if (Array.isArray(value)) value.forEach(child => visit(child, callback));
        else if (value && typeof value === 'object') visit(value, callback);
    }
}

function literalPaths(node) {
    if (node?.type === 'Literal' && typeof node.value === 'string') return [node.value];
    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return [node.quasis[0].value.cooked];
    if (node?.type === 'ArrayExpression') return node.elements.flatMap(literalPaths);
    return [`<computed: ${node?.type ?? 'missing'}>`];
}

function importRouters(relative, tree) {
    const output = new Map();
    for (const node of tree.body) {
        if (node.type !== 'ImportDeclaration') continue;
        for (const specifier of node.specifiers) {
            if (specifier.type !== 'ImportSpecifier' || specifier.imported.name !== 'router') continue;
            const filename = path.resolve(sourceRoot, path.dirname(relative), node.source.value);
            output.set(specifier.local.name, {
                file: path.relative(sourceRoot, filename).replaceAll(path.sep, '/'),
                name: 'router',
            });
        }
    }
    return output;
}

function joinRoute(prefix, route) {
    const joined = `${prefix}/${route}`.replaceAll(/\/{2,}/g, '/');
    return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
}

function sourceLink(file, line) {
    return `https://github.com/SillyTavern/SillyTavern/blob/${PINNED_COMMIT}/${file}#L${line}`;
}

function generateRoutes() {
    const existingStatuses = readExistingApiStatuses();
    const files = [...walk('src'), 'server.js'];
    const parsed = new Map(files.map(file => [file, parse(file)]));
    const imports = new Map([...parsed].map(([file, item]) => [file, importRouters(file, item.tree)]));
    const mounts = [];
    const declarations = [];

    for (const [file, { tree }] of parsed) {
        const importedRouters = imports.get(file);
        const names = new Set();
        visit(tree, node => {
            if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || node.init?.type !== 'CallExpression') return;
            const callee = node.init.callee;
            if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier'
                && callee.object.name === 'express' && callee.property.name === 'Router') names.add(node.id.name);
        });
        visit(tree, node => {
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
                && node.callee.property.name === 'use') {
                const object = node.callee.object;
                const sourceName = object.type === 'Identifier' ? object.name : null;
                const isApp = sourceName === 'app';
                const sourceRouter = sourceName && (importedRouters.has(sourceName)
                    ? importedRouters.get(sourceName)
                    : names.has(sourceName) ? { file, name: sourceName } : null);
                const basePaths = literalPaths(node.arguments[0]);
                const targetArg = node.arguments.find(arg => arg?.type === 'Identifier'
                    && (importedRouters.has(arg.name) || names.has(arg.name)));
                const targetRouter = targetArg && (importedRouters.has(targetArg.name)
                    ? importedRouters.get(targetArg.name)
                    : { file, name: targetArg.name });
                if (targetRouter && (isApp || sourceRouter)) {
                    for (const base of basePaths) mounts.push({
                        file,
                        source: isApp ? null : sourceRouter,
                        target: targetRouter,
                        base,
                        line: node.loc.start.line,
                    });
                }
            }
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed) {
                const object = node.callee.object;
                const method = node.callee.property.name;
                const directApp = object.type === 'Identifier' && object.name === 'app';
                const routerName = object.type === 'Identifier' && names.has(object.name) ? object.name : null;
                if ((directApp || routerName) && routeMethods.has(method)) {
                    for (const route of literalPaths(node.arguments[0])) {
                        declarations.push({ file, routerName, method: method.toUpperCase(), route, directApp, line: node.loc.start.line });
                    }
                }
            }
        });
    }

    const bases = new Map();
    const nodeKey = node => `${node.file}#${node.name}`;
    const addBase = (node, base) => {
        const key = nodeKey(node);
        if (!bases.has(key)) bases.set(key, new Set());
        if (bases.get(key).has(base)) return false;
        bases.get(key).add(base);
        return true;
    };
    for (const mount of mounts) {
        if (mount.source === null && (mount.file === 'src/server-startup.js' || mount.file === 'src/server-main.js')) {
            addBase(mount.target, mount.base);
        }
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const mount of mounts) {
            if (mount.source === null) continue;
            const parentBases = bases.get(nodeKey(mount.source));
            if (!parentBases) continue;
            for (const parent of parentBases) changed = addBase(mount.target, joinRoute(parent, mount.base)) || changed;
        }
    }

    const rows = [];
    for (const declaration of declarations) {
        const routeNode = { file: declaration.file, name: declaration.routerName };
        const prefixes = declaration.directApp ? ['/'] : [...(bases.get(nodeKey(routeNode)) ?? [])];
        if (prefixes.length === 0) prefixes.push(`<unmounted:${declaration.file}>`);
        for (const prefix of prefixes) {
            const fullPath = prefix.startsWith('<') ? `${prefix}${declaration.route}` : joinRoute(prefix, declaration.route);
            rows.push({ ...declaration, fullPath });
        }
    }
    rows.sort((a, b) => a.fullPath.localeCompare(b.fullPath) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file) || a.line - b.line);

    const redirects = [];
    const startupSource = read('src/server-startup.js');
    const redirectPattern = /\bredirect\(\s*(['"])(.*?)\1\s*,\s*(['"])(.*?)\3/g;
    for (const match of startupSource.matchAll(redirectPattern)) {
        const line = startupSource.slice(0, match.index).split('\n').length;
        redirects.push({ source: match[2], destination: match[4], line });
    }

    const lines = [
        '# Pinned HTTP route inventory',
        '',
        `Baseline: SillyTavern ${PINNED_VERSION} at \`${PINNED_COMMIT}\`. Generated from \`src/server-main.js\`, \`src/server-startup.js\`, \`src/users.js\`, and \`src/endpoints/**\`.`,
        '',
        'This inventory records route declarations and router mounts from the pinned source. A `partial` route has only the explicitly listed observer coverage; it does not establish middleware or end-to-end parity.',
        '',
        `Route registrations found: **${rows.length}**. Method/path values that depend on computed expressions remain visible in the table for manual source tracing.`,
        '',
        '| Method | Full path | Upstream declaration | Current status |',
        '|---|---|---|---|',
        ...rows.map(row => {
            const defaultStatus = row.method === 'GET' && row.fullPath === '/'
                ? 'partial: fresh-start static body/status/content type match the pinned oracle; shared middleware remains unimplemented'
                : row.method === 'GET' && row.fullPath === '/callback/:source?'
                ? 'partial: one encoded OAuth source/query case matches the pinned 307 target, stable headers, and text/HTML response bodies; other inputs and middleware remain unimplemented'
                : row.method === 'GET' && row.fullPath === '/login'
                ? 'partial: account-disabled 302 response, login page bytes/selected headers, and passwordless single-user auto-login session match pinned probes; proxy-auth integrations and cache/compression behavior remain'
                : row.method === 'GET' && row.fullPath === '/version'
                ? 'partial: response body/status/content type match the fresh-start oracle; shared middleware remains unimplemented'
                : row.method === 'GET' && row.fullPath === '/csrf-token'
                ? 'partial: default and disabled CSRF token responses match dedicated Node oracles; default and account-enabled modes also match signed session cookies, token reuse, cookie expiry, and attributes; other middleware remains unimplemented'
                : row.method === 'POST' && row.fullPath === '/api/ping'
                ? 'partial: valid/invalid CSRF responses, empty-string token handling, unknown-field retention, and account-authenticated access match pinned Node probes; query-driven extension and shared middleware remain unimplemented'
                : row.method === 'POST' && row.fullPath === '/api/users/list'
                ? 'partial: enabled-user projection, stable creation order, public/default avatar, and JSON response match the pinned account-session probe; discreet-login is source-implemented but unprobed, as are custom avatars and remaining errors'
                : row.method === 'POST' && row.fullPath === '/api/users/login'
                ? 'partial: missing/unknown user responses, no-password login, session version, and Unicode-normalized scrypt vector match pinned probes; protected-password endpoint success, disabled-user and limiter errors, and malformed bodies need probes'
                : 'not implemented';
            const status = existingStatuses.routes.get(apiStatusKey(row.method, row.fullPath, row.file, row.line)) ?? defaultStatus;
            return `| ${row.method} | \`${row.fullPath}\` | [${row.file}:${row.line}](${sourceLink(row.file, row.line)}) | ${status} |`;
        }),
        '',
        '## Deprecated redirects',
        '',
        'The pinned server installs these with `app.use` and sends HTTP 308, preserving the request method. They are not folded into the route table because they are redirects to current API paths.',
        '',
        '| Legacy path | Destination | Upstream declaration | Current status |',
        '|---|---|---|---|',
        ...redirects.map(row => {
            const status = existingStatuses.redirects.get(apiStatusKey(row.source, row.destination, 'src/server-startup.js', row.line)) ?? 'not implemented';
            return `| \`${row.source}\` | \`${row.destination}\` | [src/server-startup.js:${row.line}](${sourceLink('src/server-startup.js', row.line)}) | ${status} |`;
        }),
        '',
        '## Non-router HTTP surface',
        '',
        '- `/`, `/callback/:source?`, `/login`, `/csrf-token`, `/version`, `/api/ping`, `/proxy/:url(*)`: registered in `src/server-main.js`.',
        '- Public `GET /callback/:source?` redirect status, target, stable headers, and text/HTML bodies match pinned observations for encoded OAuth query values; the per-request timing header is normalized out and other route-level middleware remains outside that probe.',
        '- `GET /login` matches the account-disabled redirect, pinned login page bytes/selected headers, and passwordless single-user auto-login session; proxy-auth integration and cache/compression behavior remain unimplemented.',
        '- Embedded static serving matches the fresh-start oracle for `GET /` and `GET /lib.js` status, content type, and body digest; other static paths and middleware behavior remain unimplemented.',
        '- The final 404 handler matches the seeded fresh-install page and a preexisting custom data-root `url-not-found.html` for GET; full middleware ordering remains unimplemented.',
        '- `/csrf-token`, `/api/ping`, `/api/users/list`, and `/api/users/login` match pinned probes for account-enabled session identity, no-password auto-login, public user listing/login, Unicode-normalized scrypt, CSRF, signed 400-day cookies, token reuse, stale-session invalidation, and unknown-field preservation; recovery/management routes and remaining middleware still need probes.',
        '- Exact authentication and the remaining route content-type, status, redirect, and error semantics require separate reference probes.',
        '',
        '## Coverage boundaries',
        '',
        '- This static inventory is not dynamic route coverage. Browser and extension traffic must still be captured.',
        '- Arbitrary Node server-plugin routes are excluded by the project contract and are not enumerated as built-in SillyTavern APIs.',
        '- The route count is a declaration count after resolving statically mounted routers; nested routers may contribute multiple full paths.',
        '',
    ];
    return lines.join('\n');
}

function flatten(value, prefix = '') {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));
    }
    return [[prefix, value]];
}

function escapedCell(value) {
    return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function jsValue(value) {
    const rendered = value === undefined ? 'undefined' : JSON.stringify(value);
    return `\`${escapedCell(rendered)}\``;
}

function migrationRows() {
    const { tree } = parse('src/config-init.js');
    let array;
    visit(tree, node => {
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'keyMigrationMap') array = node.init;
    });
    if (array?.type !== 'ArrayExpression') throw new Error('could not locate keyMigrationMap in src/config-init.js');
    const result = [];
    for (const entry of array.elements) {
        if (entry?.type !== 'ObjectExpression') continue;
        const fields = new Map(entry.properties.filter(prop => prop.type === 'Property').map(prop => [prop.key.name, prop.value]));
        const getString = key => fields.get(key)?.type === 'Literal' ? fields.get(key).value : undefined;
        const oldKey = getString('oldKey');
        const newKey = getString('newKey');
        if (!oldKey || !newKey) continue;
        const remove = getString('remove') === true;
        const migrate = fields.get('migrate');
        const transform = remove ? 'remove legacy key' : migrate ? read('src/config-init.js').slice(migrate.start, migrate.end).replaceAll('\n', ' ') : 'identity';
        result.push({ oldKey, newKey, transform });
    }
    return result;
}

function generateConfig() {
    const config = yaml.parse(read('default/config.yaml'));
    const defaults = flatten(config);
    const files = [...walk('src'), 'server.js'];
    const readSites = new Map();
    const configCall = /\bgetConfigValue\(\s*(['"])(.*?)\1/g;
    for (const file of files) {
        const source = read(file);
        for (const match of source.matchAll(configCall)) {
            const line = source.slice(0, match.index).split('\n').length;
            if (!readSites.has(match[2])) readSites.set(match[2], []);
            readSites.get(match[2]).push(`${file}:${line}`);
        }
    }

    const options = [];
    const cliSource = read('src/command-line.js');
    const cliTree = espree.parse(cliSource, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
    visit(cliTree, node => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.name !== 'option') return;
        const name = node.arguments[0];
        const metadata = node.arguments[1];
        if (name?.type !== 'Literal' || typeof name.value !== 'string') return;
        const fields = new Map((metadata?.properties ?? []).filter(prop => prop.type === 'Property' && prop.key.type === 'Identifier').map(prop => [prop.key.name, prop.value]));
        const literalValue = key => fields.get(key)?.value;
        options.push({ name: name.value, type: literalValue('type') ?? 'inferred', description: String(literalValue('describe') ?? '').replaceAll('|', '\\|').replaceAll('\n', ' '), line: node.callee.property.loc.start.line });
    });

    const migrations = migrationRows();
    const lines = [
        '# Pinned configuration inventory',
        '',
        `Baseline: SillyTavern ${PINNED_VERSION} at \`${PINNED_COMMIT}\`. Defaults are read from \`default/config.yaml\`; CLI options and key migrations are read from \`src/command-line.js\` and \`src/config-init.js\`.`,
        '',
        `Default leaf keys inventoried: **${defaults.length}**. CLI options inventoried: **${options.length}**.`,
        '',
        'Pinned `getConfigValue(key, default, type)` first reads `SILLYTAVERN_` plus the uppercased key with dots changed to underscores, then falls back to YAML. A present environment variable takes precedence over YAML. Type conversion is call-site-specific. The CLI parser applies explicit command-line values before config lookups for fields listed below.',
        '',
        '## Default YAML leaf values',
        '',
        '| Config key | Pinned default | Static read sites found |',
        '|---|---|---|',
        ...defaults.map(([key, value]) => `| \`${key}\` | ${jsValue(value)} | ${(readSites.get(key) ?? []).map(site => `\`${site}\``).join(', ') || 'not found by literal `getConfigValue` scan'} |`),
        '',
        '## CLI options',
        '',
        'The parser derives additional operational defaults in `CommandLineParser.getDefaultConfig()` and `parse()`. This option list inventories declarations; exact precedence and derived values still require probes.',
        '',
        '| Option | Type | Description | Source |',
        '|---|---|---|---|',
        ...options.sort((a, b) => a.name.localeCompare(b.name)).map(option => `| \`--${option.name}\` | ${jsValue(option.type)} | ${escapedCell(option.description)} | [src/command-line.js:${option.line}](${sourceLink('src/command-line.js', option.line)}) |`),
        '',
        '## Config migrations',
        '',
        'Migrations run in `addMissingConfigValues()` before missing defaults are added. The same old-to-new environment-variable names are redirected when the old environment variable is present and the new one is absent. The pinned Node probe records fresh-file YAML bytes, a legacy config with key migrations/default insertion/unknown fields, and a legacy environment variable migration.',
        '',
        '| Legacy key | New key | Transform recorded from source |',
        '|---|---|---|',
        ...migrations.map(migration => `| \`${migration.oldKey}\` | \`${migration.newKey}\` | ${escapedCell(migration.transform)} |`),
        '',
        '## Implementation status',
        '',
        '- Fresh config bytes and existing-config migration/default insertion: implemented against the pinned Node oracle in `internal/configinit`.',
        '- Runtime read sites: statically detected only for literal `getConfigValue()` calls; dynamic key use needs manual review.',
        '- CLI precedence, global-mode path rules, deprecated aliases, data-root creation, malformed-config continuation, and startup integration: not implemented or not fully probed.',
        '',
    ];
    return lines.join('\n');
}

for (const input of ['server.js', 'src/server-main.js', 'src/server-startup.js', 'src/users.js', 'src/config-init.js', 'src/command-line.js', 'default/config.yaml']) read(input);
for (const [name, content] of [['api-inventory.md', generateRoutes()], ['config-inventory.md', generateConfig()]]) {
    writeFileSync(path.join(outputRoot, 'docs', name), content);
    console.log(`wrote docs/${name}`);
}
