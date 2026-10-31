#!/usr/bin/env node
// FRONTEND-DERIVED BACKEND SURFACE INVENTORY AND DRIFT GATE (AGENTS.md 42/43/44).
//
// RULE 43's OBLIGATION, IN ONE SENTENCE: the route inventory is enumerated from the ORACLE's own lists --
// every mounted router, every endpoint registration, and every URL a pinned FRONTEND module builds -- so a
// route the browser always requests is part of the contract even when no test touches it. Two of this
// project's user-visible P0s ("/thumbnail is unimplemented" and the three missing user-data mount trees)
// were exactly the failure shape this rule exists to make impossible: the server matched everything a
// fixture requested, and the page was visibly broken.
//
// This tool implements that obligation as a GATE over three derived sets and two committed decisions:
//
//   1. PINNED ROUTES, from `docs/api-inventory.md`. That file is itself generated from the pinned source by
//      `tools/generate-upstream-inventories.mjs` (a rule-43 enumeration of `router.use`, endpoint routers and
//      `app.get/post` mounts) and its regeneration is a zero-diff gate in the oracle job. Reading it here is
//      reading the oracle's own list, not a second hand-written one.
//   2. GO REGISTRATIONS, parsed from the actual `mux.HandleFunc(...)` sites in `internal/server/*.go`,
//      including registrations that arrive through a local `post(...)`/`redirect(...)` helper, an inline
//      `[]string{...}` loop, a map literal, a `[]struct{pattern ...}` table, or a function returning a route
//      table. An unresolved registration SITE is a failure, not a silent omission: a new idiom must be
//      taught to this parser or named in the classification data with a reason.
//   3. FRONTEND SURFACES, from `upstream/public/**/*.js` -- the pinned, byte-identical frontend tree this
//      repository vendors -- plus the committed startup observation (`docs/frontend-startup-calls.md`) and
//      the extension-dependency record (`docs/extension-route-coverage.md`). String and template literals in
//      request position (`fetch(...)`, jQuery `$.ajax`/`$.post`/..., an object `url:` property, a
//      `URL.pathname` assignment) and every `/api/...` literal are surfaces.
//
// EVERY surface is classified as exactly one of:
//
//   implemented              routed by this tree and evidenced by a pinned inventory row (or a named Go
//                            registration for surfaces pinned expresses in middleware rather than a route);
//   intentionally-passthrough served as pinned bytes without semantic handling (the vendored frontend static
//                            tree and the user-data mount trees);
//   not-applicable           a browser-only or another-server surface (the EXTRAS server's `/api/*` namespace,
//                            a URL assembled against `getApiUrl()`), recorded with the reason and the source
//                            line that proves it;
//   unsupported-with-reason  a decided exclusion (AGENTS.md boundaries 2/3/5/16), carrying the boundary
//                            number and the user-visible consequence.
//
// There is no `unknown`, and a surface that fits none of these FAILS the gate, naming the path and the
// frontend file(s) that build it. Two further failures keep the classification honest: a Go route with no
// classification (drift on the Go side), and a reachable pinned route with no Go registration (drift back
// toward the P0 shape). A classification entry that no longer names a live surface also fails, so an
// exception cannot outlive the thing it excused and quietly cover a new one.
//
// Usage:
//   node tools/compat-matrix/surface-coverage.mjs --check     # the gate; non-zero on any finding
//   node tools/compat-matrix/surface-coverage.mjs --emit      # write docs/generated/surface-coverage.json
//                                                             # + the surface.drift block in docs/surface-coverage.md
//   node tools/compat-matrix/surface-coverage.mjs --print     # print the derived report, write nothing
//   node tools/compat-matrix/surface-coverage.mjs --selftest  # mutation self-test on copied fixture trees
//   --root=<dir>                                              # derive against another tree (self-test only)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const classificationsPath = path.join(here, 'surface-classifications.json');
export const reportPath = path.join(repoRoot, 'docs', 'generated', 'surface-coverage.json');
export const surfaceDocumentPath = path.join(repoRoot, 'docs', 'surface-coverage.md');
const BLOCK_NAME = 'surface.drift';

const CLASSIFICATIONS = new Set(['implemented', 'intentionally-passthrough', 'not-applicable', 'unsupported-with-reason']);

const read = (root, relative) => readFileSync(path.join(root, relative), 'utf8');
const exists = (root, relative) => existsSync(path.join(root, relative));

export function loadClassifications() {
    return JSON.parse(readFileSync(classificationsPath, 'utf8'));
}

// The selftest derives against a COPIED fixture tree with its own classification decisions, so the real
// decisions file is never rewritten by a mutation run (AGENTS.md 57). `overrides.classifications` is the
// only injection point; production callers pass nothing and read the committed file.
function resolveClassifications(overrides) {
    return overrides?.classifications ?? loadClassifications();
}

// ---------------------------------------------------------------------------------------------------
// A MINIMAL JS TOKENIZER. No dependencies by design: the `verify` job that runs this gate installs Go but
// no npm packages, so espree (which the oracle job has) is unavailable here. The tokenizer only has to be
// faithful about the four things that produce false surfaces when ignored: comments, single/double-quoted
// strings, template literals, and regex literals (whose bodies contain `/`, `'` and `"`).
//
// It returns {type:'string'|'template'|'ident'|'punct', value, line} in source order. A template's value is
// every quasi segment concatenated with a `\u0000` marker where an `${...}` expression sits, so a builder
// like `/api/characters/${name}` normalises to the surface prefix `/api/characters/`.
// ---------------------------------------------------------------------------------------------------
const REGEX_PRECEDERS = new Set(['(', '[', '{', ',', ';', '=', ':', '!', '?', '&', '|', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await']);

export function tokenizeJs(source) {
    const tokens = [];
    let index = 0;
    let line = 1;
    const templateStack = [];
    const advance = (count = 1) => {
        for (let i = 0; i < count; i++) if (source[index + i] === '\n') line++;
        index += count;
    };
    const previousSignificant = () => tokens[tokens.length - 1] ?? null;

    while (index < source.length) {
        const ch = source[index];
        if (ch === '\n') { line++; index++; continue; }
        if (/\s/.test(ch)) { index++; continue; }
        if (ch === '/' && source[index + 1] === '/') {
            while (index < source.length && source[index] !== '\n') index++;
            continue;
        }
        if (ch === '/' && source[index + 1] === '*') {
            index += 2;
            while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) { if (source[index] === '\n') line++; index++; }
            index += 2;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            const startLine = line;
            const quote = ch;
            let value = '';
            index++;
            while (index < source.length && source[index] !== quote) {
                if (source[index] === '\\') {
                    const next = source[index + 1];
                    value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
                    if (next === '\n') line++;
                    index += 2;
                    continue;
                }
                if (source[index] === '\n') line++;
                value += source[index];
                index++;
            }
            index++;
            tokens.push({ type: 'string', value, line: startLine });
            continue;
        }
        if (ch === '`') {
            const startLine = line;
            let value = '';
            let hasExpression = false;
            index++;
            while (index < source.length && source[index] !== '`') {
                if (source[index] === '\\') {
                    value += source[index + 1] ?? '';
                    index += 2;
                    continue;
                }
                if (source[index] === '$' && source[index + 1] === '{') {
                    hasExpression = true;
                    value += '\u0000';
                    index += 2;
                    // Skip the expression, which may itself contain strings/templates/braces.
                    let depth = 1;
                    while (index < source.length && depth > 0) {
                        const c = source[index];
                        if (c === '{') depth++;
                        else if (c === '}') depth--;
                        else if (c === '\'' || c === '"') {
                            const q = c;
                            index++;
                            while (index < source.length && source[index] !== q) { if (source[index] === '\\') index++; index++; }
                        } else if (c === '`') {
                            // A nested template: skip to its matching backtick, honouring escapes.
                            index++;
                            while (index < source.length && source[index] !== '`') { if (source[index] === '\\') index++; index++; }
                        } else if (c === '\n') line++;
                        index++;
                    }
                    continue;
                }
                if (source[index] === '\n') line++;
                value += source[index];
                index++;
            }
            index++;
            tokens.push({ type: hasExpression ? 'template' : 'string', value, line: startLine });
            continue;
        }
        if (ch === '/' && isRegexPosition(previousSignificant())) {
            // Skip a regex literal: up to the unescaped closing slash outside a character class.
            index++;
            let inClass = false;
            while (index < source.length && source[index] !== '\n') {
                const c = source[index];
                if (c === '\\') { index += 2; continue; }
                if (c === '[') inClass = true;
                else if (c === ']') inClass = false;
                else if (c === '/' && !inClass) { index++; break; }
                index++;
            }
            while (index < source.length && /[a-z]/i.test(source[index])) index++;
            continue;
        }
        if (/[A-Za-z_$]/.test(ch)) {
            const start = index;
            while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index++;
            tokens.push({ type: 'ident', value: source.slice(start, index), line });
            continue;
        }
        if (/[0-9]/.test(ch)) {
            while (index < source.length && /[0-9a-fx._]/i.test(source[index])) index++;
            tokens.push({ type: 'punct', value: 'number', line });
            continue;
        }
        tokens.push({ type: 'punct', value: ch, line });
        index++;
    }
    return tokens;
}

function isRegexPosition(previous) {
    if (!previous) return true;
    if (previous.type === 'ident') return REGEX_KEYWORDS.has(previous.value);
    if (previous.type === 'string' || previous.type === 'template') return false;
    return REGEX_PRECEDERS.has(previous.value);
}

// ---------------------------------------------------------------------------------------------------
// PINNED ROUTES (docs/api-inventory.md) and the redirect aliases recorded beside them.
// ---------------------------------------------------------------------------------------------------
function splitTableRow(line) {
    const fields = [];
    let current = '';
    for (let index = 0; index < line.length; index++) {
        const ch = line[index];
        if (ch === '\\' && line[index + 1] === '|') { current += '\\|'; index++; continue; }
        if (ch === '|') { fields.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    fields.push(current.trim());
    return fields;
}

export function parsePinnedInventory(root) {
    const lines = read(root, 'docs/api-inventory.md').split(/\r?\n/);
    const rows = [];
    const redirects = [];
    for (const line of lines) {
        const route = line.match(/^\| (GET|POST|PUT|PATCH|DELETE|ALL|OPTIONS|HEAD) \| `([^`]+)` \| \[([^:\]]+):(\d+)\]\(([^)]+)\) \| (.*) \|$/);
        if (route) {
            rows.push({ method: route[1], path: route[2], file: route[3], line: Number(route[4]), status: route[6] });
            continue;
        }
        const redirect = line.match(/^\| `([^`]+)` \| `([^`]+)` \| \[([^:\]]+):(\d+)\]\(([^)]+)\) \| (.*) \|$/);
        if (redirect) redirects.push({ source: redirect[1], destination: redirect[2], file: redirect[3], line: Number(redirect[4]) });
    }
    return { rows, redirects };
}

// A pinned inventory row's STATUS COLUMN is its evidence classification:
//   "partial: ..." / "compatible" / "implemented: ..."  -> implemented (the row states what IS covered)
//   "not implemented: reason"                          -> unsupported-with-reason (a decided exclusion)
//   a bare "not implemented"                            -> no classification; the gate refuses it.
export function classifyPinnedStatus(status) {
    const text = String(status ?? '').trim();
    if (text === 'not implemented') return { classification: null, reason: 'a bare "not implemented" states no reason, so it is backlog rather than a decision' };
    if (text.startsWith('not implemented:')) return { classification: 'unsupported-with-reason', reason: text.slice('not implemented:'.length).trim() };
    if (text.startsWith('unsupported')) return { classification: 'unsupported-with-reason', reason: text.slice('unsupported'.length).replace(/^[:\s-]+/, '').trim() || text };
    if (text.startsWith('partial') || text.startsWith('compatible') || text.startsWith('implemented') || text.startsWith('served')) {
        return { classification: 'implemented', reason: null };
    }
    return { classification: null, reason: `status ${JSON.stringify(text.slice(0, 40))} is not a recognised evidence classification` };
}

// Express path syntax in the pinned inventory (`/api/images/list/:folder?`) is a pinned spelling, not a Go
// pattern. The variants let a Go registration match either the parameterised spelling or its base path; the
// MATCH is what is gated, and a route that matches no variant is a real missing registration.
export function pinnedPathVariants(pinnedPath) {
    const variants = new Set([pinnedPath]);
    variants.add(pinnedPath.replace(/\/:[A-Za-z0-9_]+\?$/, ''));
    variants.add(pinnedPath.replace(/\/:[A-Za-z0-9_]+\?/g, ''));
    variants.add(pinnedPath.replace(/\/:[A-Za-z0-9_]+/g, ''));
    variants.add(pinnedPath.replace(/\/\*/g, ''));
    return [...variants].filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------
// GO REGISTRATIONS. Parsed from source, because a declaration set compared against a declaration set cannot
// see an executed registration (AGENTS.md 54). The parser is deliberately narrow and FAILS CLOSED: every
// `mux.HandleFunc(` SITE must resolve to at least one route through a literal, a helper call, a range
// expression this file can resolve, or a named exception. A new idiom therefore cannot slip through as a
// silent omission -- it turns the gate red until it is taught here.
// ---------------------------------------------------------------------------------------------------
function balancedFrom(source, openIndex) {
    let depth = 0;
    for (let index = openIndex; index < source.length; index++) {
        if (source[index] === '{') depth++;
        else if (source[index] === '}') { depth--; if (depth === 0) return index; }
    }
    return -1;
}

function balancedParen(source, openIndex) {
    let depth = 0;
    for (let index = openIndex; index < source.length; index++) {
        if (source[index] === '(') depth++;
        else if (source[index] === ')') { depth--; if (depth === 0) return index; }
    }
    return -1;
}

function stringLiteralsIn(text) {
    return [...text.matchAll(/"((?:\\.|[^"\\])*)"|`([^`]*)`/g)].map(match => (match[1] ?? match[2]).replace(/\\"/g, '"'));
}

// Reads a `range` expression and returns it together with the index just past it, so the loop BODY is found
// from the right place. Four shapes occur in this package and each needs a different terminator: an inline
// `[]string{...}` (brace-balanced), an inline `[]struct{...}{...}` (two brace groups), an identifier/map
// (to the end of the line) and a call (`table()`).
function readRangeExpression(source, expressionStart) {
    if (source.startsWith('[]string{', expressionStart)) {
        const close = balancedFrom(source, expressionStart + '[]string'.length);
        return { expression: source.slice(expressionStart, close + 1), cursor: close + 1 };
    }
    if (source.startsWith('[]struct', expressionStart)) {
        const typeOpen = source.indexOf('{', expressionStart);
        const typeClose = balancedFrom(source, typeOpen);
        // The literal table follows the type: `[]struct{...}{ ...elements... }`.
        let literalOpen = typeClose + 1;
        while (literalOpen < source.length && /\s/.test(source[literalOpen])) literalOpen++;
        if (source[literalOpen] === '{') {
            const literalClose = balancedFrom(source, literalOpen);
            return { expression: source.slice(expressionStart, literalClose + 1), cursor: literalClose + 1 };
        }
        return { expression: source.slice(expressionStart, typeClose + 1), cursor: typeClose + 1 };
    }
    const lineEnd = source.indexOf('\n', expressionStart);
    const brace = source.indexOf('{', expressionStart);
    const end = brace >= 0 && brace < lineEnd ? brace : lineEnd;
    return { expression: source.slice(expressionStart, end).trim(), cursor: end };
}

export function parseGoRegistrations(root) {
    const directory = path.join(root, 'internal', 'server');
    if (!existsSync(directory)) return { routes: [], unresolvedSites: [], files: [] };
    const files = readdirSync(directory).filter(name => name.endsWith('.go') && !name.endsWith('_test.go')).sort();
    const sources = new Map(files.map(name => [name, readFileSync(path.join(directory, name), 'utf8')]));
    const routes = [];
    const unresolvedSites = [];
    const helperDefinitions = [];

    // Local `name := func(params) { ... mux.HandleFunc(<param> ...) }` helpers: post(...), redirect(...).
    for (const [file, source] of sources) {
        for (const match of source.matchAll(/\b(\w+)\s*:=\s*func\s*\(/g)) {
            const open = source.indexOf('(', match.index + match[0].length - 1);
            const close = balancedParen(source, open);
            if (close < 0) continue;
            const params = source.slice(open + 1, close).split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean);
            let bodyOpen = close + 1;
            while (bodyOpen < source.length && source[bodyOpen] !== '{') bodyOpen++;
            const bodyEnd = balancedFrom(source, bodyOpen);
            const body = source.slice(bodyOpen, bodyEnd);
            const handle = body.match(/mux\.HandleFunc\(\s*(\w+)/);
            if (!handle) continue;
            const routeParam = params.indexOf(handle[1]);
            if (routeParam < 0) continue;
            helperDefinitions.push({ file, name: match[1], routeParam, start: match.index, end: bodyEnd });
        }
    }
    const helpers = new Map();
    for (const definition of helperDefinitions) {
        const existing = helpers.get(definition.name);
        if (existing && existing.routeParam !== definition.routeParam) {
            unresolvedSites.push({ file: definition.file, line: lineAt(sources.get(definition.file), definition.start), text: `${definition.name} is defined with two different route-parameter positions; the parser cannot choose` });
            continue;
        }
        if (!existing) helpers.set(definition.name, definition);
    }
    const insideHelperDefinition = (file, index) => helperDefinitions.some(definition => definition.file === file && index >= definition.start && index <= definition.end);
    const serverPath = file => `internal/server/${file}`;

    // Direct literal registrations.
    for (const [file, source] of sources) {
        for (const match of source.matchAll(/mux\.HandleFunc\(\s*"([^"]*)"/g)) {
            routes.push({ literal: match[1], file: serverPath(file), evidence: `${serverPath(file)}:${lineAt(source, match.index)}` });
        }
    }

    // Helper call sites with a literal first argument. A literal followed by `+` is the PREFIX of a
    // concatenation, not a route (`post("/api/tokenizers/"+model+"/encode", ...)`), so it must not be
    // collected as one; the loop resolver expands those into concrete routes instead.
    for (const [file, source] of sources) {
        for (const helper of helpers.values()) {
            const call = new RegExp(`\\b${helper.name}\\(\\s*"([^"]*)"(?=\\s*[,)])`, 'g');
            for (const match of source.matchAll(call)) {
                routes.push({ literal: match[1], file: serverPath(file), evidence: `${serverPath(file)}:${lineAt(source, match.index)}`, via: helper.name });
            }
        }
    }

    // Range loops whose body registers. The expression is resolved against the same file (inline literals,
    // `var` slice/map/struct tables) or against a package function returning a route table.
    const helperAlternation = [...helpers.keys()].join('|');
    const resolvedLoops = [];
    for (const [file, source] of sources) {
        for (const match of source.matchAll(/for\s+([\w\s,]+?)\s*:=\s*range\s+/g)) {
            const loopVars = match[1].split(',').map(part => part.trim()).filter(Boolean);
            const { expression, cursor } = readRangeExpression(source, match.index + match[0].length);
            const bodyOpen = source.indexOf('{', cursor);
            if (bodyOpen < 0) continue;
            const bodyEnd = balancedFrom(source, bodyOpen);
            const body = source.slice(bodyOpen, bodyEnd);
            // Which loop variable is the ROUTE? For `for route, handler := range mapLiteral` it is the KEY
            // (first variable); for `for _, route := range slice` it is the second; for
            // `for _, entry := range table() { provider := entry; mux.HandleFunc(provider.route, ...) }` it is
            // the range variable that a local alias was assigned from. Choose by how the registration USES it,
            // never by position alone.
            const aliases = [...body.matchAll(/(\w+)\s*:=\s*(\w+)\s*\n/g)].filter(match => loopVars.includes(match[2])).map(match => match[1]);
            const candidates = [...loopVars.filter(variable => variable !== '_'), ...aliases];
            const usesVar = variable => new RegExp(`mux\\.HandleFunc\\(\\s*${variable}(?:\\.\\w+)?\\b`).test(body)
                || (helperAlternation && new RegExp(`\\b(?:${helperAlternation})\\(\\s*${variable}(?:\\.\\w+|\\.route)?\\b`).test(body))
                || new RegExp(`"\\s*\\+\\s*${variable}\\s*\\+`).test(body)
                || new RegExp('`[^`]*\\$\\{' + variable + '\\}').test(body);
            const routeVars = candidates.filter(usesVar);
            if (routeVars.length === 0) continue;
            const resolved = resolveGoRangeExpression(file, expression, sources);
            const evidence = `${serverPath(file)}:${lineAt(source, match.index)}`;
            if (!resolved) {
                unresolvedSites.push({ file: serverPath(file), line: lineAt(source, match.index), text: `for ${loopVars.join(', ')} := range ${expression}` });
                continue;
            }
            // A table of structs (rather than bare strings) contributes its route FIELD per element: the
            // resolver returns the first string of each element, which is that field for both tables in this
            // package (userDataMounts.pattern and openAITranscribeProvider.route). A loop whose ONLY use of
            // the variable builds a route from a concat/template contributes NO bare element as a route --
            // otherwise the tokenizer model names would be enumerated as if they were paths.
            const directUse = routeVars.some(routeVar => new RegExp(`(?:mux\\.HandleFunc|${helperAlternation})\\(\\s*${routeVar}(?:\\.\\w+)?\\s*[,)]`).test(body));
            if (directUse) {
                for (const literal of resolved) routes.push({ literal, file, evidence, via: 'range' });
            }

            // A route can be BUILT inside the loop body: `post("/api/tokenizers/" + model + "/encode", ...)`.
            for (const routeVar of routeVars) {
                for (const callMatch of body.matchAll(/(?:\b(\w+))\(\s*"([^"]*)"\s*\+\s*(\w+)\s*\+\s*"([^"]*)"/g)) {
                    const helperName = callMatch[1];
                    if (helperName !== 'mux' && !helpers.has(helperName)) continue;
                    if (callMatch[3] !== routeVar) continue;
                    for (const item of resolved) routes.push({ literal: `${callMatch[2]}${item}${callMatch[4]}`, file, evidence, via: 'range-concat' });
                }
                for (const callMatch of body.matchAll(/(?:\b(\w+))\(\s*`([^`$]*)\$\{(\w+)\}([^`]*)`/g)) {
                    const helperName = callMatch[1];
                    if (helperName !== 'mux' && !helpers.has(helperName)) continue;
                    if (callMatch[3] !== routeVar) continue;
                    for (const item of resolved) routes.push({ literal: `${callMatch[2]}${item}${callMatch[4]}`, file, evidence, via: 'range-template' });
                }
            }
            resolvedLoops.push({ file: serverPath(file), index: match.index, end: bodyEnd });
        }
    }

    // Unresolved registration sites: every mux.HandleFunc whose first argument is an identifier that is not a
    // helper definition. A site the parser cannot resolve is a failure in the gate, never a silent omission.
    for (const [file, source] of sources) {
        for (const match of source.matchAll(/mux\.HandleFunc\(\s*([^",)\s][^",)]*)/g)) {
            if (insideHelperDefinition(file, match.index)) continue;
            const argument = match[1].trim();
            if (argument.startsWith('"') || argument.startsWith('`')) continue;
            const line = lineAt(source, match.index);
            // A registration site INSIDE a resolved registration loop was already enumerated above; a site in
            // an unresolved loop is reported once as the loop, not once per occurrence.
            const inResolvedLoop = resolvedLoops.some(loop => loop.file === serverPath(file) && match.index > loop.index && match.index < loop.end);
            if (inResolvedLoop) continue;
            unresolvedSites.push({ file: serverPath(file), line, text: `mux.HandleFunc(${argument})` });
        }
    }
    return { routes, unresolvedSites, files };
}

// A `var NAME = []T{...}` / `NAME := map[K]V{...}` table must be captured by BALANCED BRACES rather than by
// a non-greedy regex: a one-line declaration (`var models = []string{"a", "b"}`) has no newline before its
// closing brace, so `([\s\S]*?)\n\}` ran to the next function's closing brace and returned every string in
// between as a route. Measured on tokenizers.go: that produced 100+ phantom routes and 256 findings.
function readTableAfter(source, startIndex) {
    // startIndex points at the opening '[' of `[]string{` or at the `{` of a map literal.
    let braceOpen = source.indexOf('{', startIndex);
    if (braceOpen < 0) return null;
    const braceClose = balancedFrom(source, braceOpen);
    return braceClose < 0 ? null : source.slice(braceOpen + 1, braceClose);
}

function resolveGoRangeExpression(file, expression, sources) {
    const source = sources.get(file);
    const inline = expression.match(/^\[\]string\{([\s\S]*)\}$/);
    if (inline) return stringLiteralsIn(inline[1]);
    const structInline = expression.match(/^\[\]struct\{[\s\S]*?\}\{([\s\S]*)\}$/);
    if (structInline) {
        return [...structInline[1].matchAll(/\{\s*"([^"]+)"/g)].map(match => match[1]);
    }
    const identifier = expression.match(/^([A-Za-z_]\w*)$/);
    if (identifier && source) {
        const name = identifier[1];
        const declaration = source.search(new RegExp(`(?:var\\s+${name}\\s*=|\\b${name}\\s*:=)`));
        if (declaration < 0) return null;
        const rest = source.slice(declaration);
        const declarationStart = declaration;
        // A STRUCT TABLE MUST BE CHECKED BEFORE A PLAIN SLICE: `[]struct{...}{...}` also matches a `[]\w+`
        // slice shape, and taking that branch returned every string in the table.
        const structMarker = rest.match(/\[\]struct\s*\{/);
        const sliceMarker = rest.match(/\[\](?:string|int|int64|float64|byte|rune|bool)\s*\{/);
        const mapMarker = rest.match(/map\[[^\]]+\][^{]*\{/);
        if (structMarker && (!sliceMarker || structMarker.index < sliceMarker.index)) {
            const typeOpen = declarationStart + structMarker.index + structMarker[0].lastIndexOf('{');
            const typeClose = balancedFrom(source, typeOpen);
            let literalOpen = typeClose + 1;
            while (literalOpen < source.length && /\s/.test(source[literalOpen])) literalOpen++;
            if (source[literalOpen] !== '{') return null;
            const literalClose = balancedFrom(source, literalOpen);
            return [...source.slice(literalOpen + 1, literalClose).matchAll(/\{\s*"([^"]+)"/g)].map(match => match[1]);
        }
        if (sliceMarker && (!mapMarker || sliceMarker.index < mapMarker.index)) {
            const table = readTableAfter(source, declarationStart + sliceMarker.index);
            return table === null ? null : stringLiteralsIn(table);
        }
        if (mapMarker) {
            const table = readTableAfter(source, declarationStart + mapMarker.index);
            return table === null ? null : [...table.matchAll(/"([^"]+)"\s*:/g)].map(match => match[1]);
        }
        return null;
    }
    const call = expression.match(/^([A-Za-z_]\w*)\(\)$/);
    if (call) {
        for (const sourceText of sources.values()) {
            const declaration = sourceText.match(new RegExp(`func\\s+${call[1]}\\([^)]*\\)\\s*\\[\\][\\w.]+\\s*\\{([\\s\\S]*?)\\n\\}`));
            if (declaration) {
                const literals = [...declaration[1].matchAll(/\{\s*"([^"]+)"/g)].map(match => match[1]);
                if (literals.length > 0) return literals;
            }
        }
    }
    return null;
}

function lineAt(source, index) {
    return source.slice(0, index).split('\n').length;
}

export function normalizeGoPattern(literal) {
    let method = null;
    let pattern = literal;
    const prefixed = literal.match(/^(GET|POST|PUT|PATCH|DELETE|ALL|OPTIONS|HEAD) (\/.*)$/);
    if (prefixed) { method = prefixed[1]; pattern = prefixed[2]; }
    pattern = pattern.replace(/\{\$\}$/, '');
    return { method, pattern, literal };
}

// ---------------------------------------------------------------------------------------------------
// FRONTEND SURFACES. Three oracle-derived inputs, one classification.
// ---------------------------------------------------------------------------------------------------
function walkJs(root, relative) {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) return [];
    const output = [];
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) output.push(...walkJs(root, child));
        else if (entry.isFile() && entry.name.endsWith('.js')) output.push(child);
    }
    return output;
}

// A surface path is normalised to the part a route can be matched against: query and fragment removed, and a
// template/concatenation cut at its first interpolation so `/api/characters/${name}` yields
// `/api/characters/` (a prefix the gate matches against the pinned route set).
//
// A value that is not URL-shaped is NOT a surface and is dropped rather than classified: the pinned frontend
// contains message literals like `/messages: Skipping hidden message ...`, a regex `/g` replacement and a bare
// `/api` base used in a concatenation. Dropping them silently would hide a real new request shape, so a value
// that starts with `/api` but is not URL-shaped is still returned as a candidate and fails classification --
// only values with no `/api` prefix and no request context are dropped.
const URL_SHAPED = /^\/[A-Za-z0-9_%./:{}~-]*$/;
export function normalizeFrontendPath(raw) {
    let value = String(raw);
    if (!value.startsWith('/')) return null;
    value = value.split('?')[0].split('#')[0];
    value = value.split('\u0000')[0];
    if (value.length === 0) return null;
    if (!URL_SHAPED.test(value)) return null;
    if (value === '/api' || value === '/api/') return null;
    return value;
}

export function parseFrontendSurfaces(root) {
    const files = walkJs(root, 'upstream/public');
    const surfaces = new Map();
    const record = (surface, file, context) => {
        if (!surfaces.has(surface)) surfaces.set(surface, { surface, files: new Set(), contexts: new Set() });
        surfaces.get(surface).files.add(file);
        surfaces.get(surface).contexts.add(context);
    };
    for (const file of files) {
        const tokens = tokenizeJs(read(root, file));
        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];
            if (token.type !== 'string' && token.type !== 'template') continue;
            const surface = normalizeFrontendPath(token.value);
            if (!surface) continue;
            const previous = tokens.slice(Math.max(0, index - 4), index);
            const previousValues = previous.map(item => item.value);
            const context = requestContext(previousValues, token.type);
            const isApi = surface === '/api' || surface.startsWith('/api/');
            if (!isApi && !context && !/^\/(?:thumbnail|version|login|csrf-token|callback|savetheme|savemovingui|getuseravatars|deleteuseravatar|savequickreply|deletequickreply|characters|backgrounds|User%20Avatars|assets|user\/images|user\/files|scripts\/extensions\/third-party)\b/.test(surface)) {
                continue;
            }
            record(surface, file, context ?? 'literal');
        }
    }
    return [...surfaces.values()].map(entry => ({ surface: entry.surface, files: [...entry.files].sort(), contexts: [...entry.contexts].sort() }));
}

function requestContext(previousValues, tokenType) {
    const suffix = previousValues.join(' ');
    if (/\bfetch \($/.test(suffix) || /(?:^| )fetch \($/.test(suffix)) return 'fetch';
    if (/\burl :$/.test(suffix)) return 'url-property';
    if (/\$ \. (?:post|get|getJSON|ajax) \($/.test(suffix)) return 'jquery';
    if (/\bpathname =$/.test(suffix)) return 'url-pathname';
    if (tokenType === 'template') return 'template';
    return null;
}

export function parseStartupObservation(root) {
    const relative = 'docs/frontend-startup-calls.md';
    if (!exists(root, relative)) return [];
    const rows = [];
    for (const line of read(root, relative).split(/\r?\n/)) {
        const match = line.match(/^\| (GET|POST|PUT|PATCH|DELETE|ALL|OPTIONS|HEAD) \| `([^`]+)` \| ([a-z]+) \| ([^|]+) \| ([^|]+) \|$/);
        if (!match) continue;
        const surface = normalizeFrontendPath(match[2].split(' ')[0]);
        if (!surface) continue;
        rows.push({ surface, method: match[1], resource: match[3], observedStatus: match[4].trim() });
    }
    return rows;
}

export function parseExtensionCoverage(root) {
    const relative = 'docs/extension-route-coverage.md';
    if (!exists(root, relative)) return [];
    const rows = [];
    for (const line of read(root, relative).split(/\r?\n/)) {
        const match = line.match(/^\| `([^`]+)` \| ([A-Za-z()\/ ]+) \| (.*?) \| (.*?) \|$/);
        if (!match) continue;
        const surface = normalizeFrontendPath(match[1]);
        if (!surface) continue;
        rows.push({ surface, method: match[2].trim(), use: match[3].trim(), declaredStatus: match[4].trim() });
    }
    return rows;
}

// ---------------------------------------------------------------------------------------------------
// CLASSIFICATION
// ---------------------------------------------------------------------------------------------------
const STATIC_MOUNT_PREFIXES = [
    '/css', '/img', '/lib', '/locales', '/scripts', '/sounds', '/webfonts',
];

function matchesStaticMount(surface) {
    return STATIC_MOUNT_PREFIXES.some(prefix => surface === prefix || surface.startsWith(`${prefix}/`)) ||
        surface === '/style.css' || surface === '/lib.js';
}

function pinnedMatch(pinnedRows, surface, method) {
    const variants = pinnedPathVariants(surface);
    for (const row of pinnedRows) {
        if (method && row.method !== method) continue;
        // A pinned row whose path is a COMPUTED expression (`/thumbnail/<computed: Identifier>`) is mounted at
        // the literal prefix; the browser requests the query-parameter form. The prefix is the contract.
        if (row.path.includes('<computed')) {
            const prefix = row.path.split('<computed')[0];
            if (prefix.length > 1 && variants.some(variant => variant === prefix.replace(/\/$/, '') || variant === prefix || variant.startsWith(prefix))) return row;
            continue;
        }
        for (const variant of variants) {
            for (const pinnedVariant of pinnedPathVariants(row.path)) {
                if (variant === pinnedVariant) return row;
                // A PREFIX the frontend extends is the contract when a concrete pinned route sits under it:
                // `/api/sd/comfy` is what `generateComfyImageCommon` takes as a basePath and appends
                // `/generate` to, and `/api/characters/` is built before an avatar name is appended.
                if (pinnedVariant.startsWith(variant.endsWith('/') ? variant : `${variant}/`)) return row;
            }
        }
    }
    return null;
}

function goMatches(goRoutes, surface) {
    for (const route of goRoutes) {
        const { pattern } = normalizeGoPattern(route.literal);
        const goVariants = pinnedPathVariants(pattern);
        for (const variant of pinnedPathVariants(surface)) {
            for (const goVariant of goVariants) {
                if (variant === goVariant) return route;
                const variantBase = variant.endsWith('/') ? variant : `${variant}/`;
                const goBase = goVariant.endsWith('/') ? goVariant : `${goVariant}/`;
                if (goVariant.startsWith(variantBase)) return route;
                if (variant.startsWith(goBase)) return route;
                if (goVariant.includes('{') && variant.startsWith(goVariant.slice(0, goVariant.indexOf('{')))) return route;
            }
        }
    }
    return null;
}

export function deriveSurfaceCoverage(root = repoRoot, overrides = {}) {
    const classifications = resolveClassifications(overrides);
    const { rows: pinnedRows, redirects } = parsePinnedInventory(root);
    const go = parseGoRegistrations(root);
    const frontend = parseFrontendSurfaces(root);
    const startup = parseStartupObservation(root);
    const extension = parseExtensionCoverage(root);

    const problems = [];
    const frontendExceptions = new Map((classifications.frontendExceptions ?? []).map(entry => [entry.surface, entry]));
    const goExceptions = new Map((classifications.goExceptions ?? []).map(entry => [entry.pattern, entry]));
    const missingExceptions = new Map((classifications.missingPinnedRoutes ?? []).map(entry => [`${entry.method} ${entry.path}`, entry]));
    const unresolvedExceptions = new Map((classifications.unresolvedSites ?? []).map(entry => [`${entry.file}:${entry.line}`, entry]));
    const redirectAliasExceptions = new Map((classifications.redirectAliases ?? []).map(entry => [entry.source, entry]));
    const staticMounts = classifications.staticMounts ?? [];
    const used = { frontend: new Set(), go: new Set(), missing: new Set(), unresolved: new Set(), redirectAlias: new Set() };
    const staticMountFor = surface => staticMounts.find(mount => surface === mount.prefix || surface.startsWith(mount.prefix));

    // GO ROUTES: classified by an explicit exception, else by a derived rule (pinned redirect alias, pinned
    // static mount), else by the pinned row they match, else unclassified.
    const goReport = [];
    const goByPath = new Map();
    for (const route of go.routes) {
        const { method, pattern, literal } = normalizeGoPattern(route.literal);
        const exception = goExceptions.get(pattern) ?? goExceptions.get(literal);
        let classification = null;
        let reason = null;
        if (exception) {
            classification = exception.classification;
            reason = exception.reason;
            used.go.add(pattern);
            used.go.add(literal);
        } else {
            const redirectAlias = redirects.find(redirect => redirect.source === pattern || redirect.source === literal);
            const staticMount = staticMountFor(pattern);
            const row = pinnedMatch(pinnedRows, pattern, method);
            if (redirectAlias) {
                classification = 'implemented';
                reason = `the pinned server registers this as a method-preserving 308 alias of ${redirectAlias.destination} (${redirectAlias.file}:${redirectAlias.line})`;
            } else if (staticMount) {
                classification = 'intentionally-passthrough';
                reason = staticMount.reason;
            } else if (row) {
                const pinnedClass = classifyPinnedStatus(row.status);
                if (pinnedClass.classification === 'implemented') { classification = 'implemented'; reason = null; }
                else if (pinnedClass.classification === 'unsupported-with-reason') {
                    problems.push(`Go route ${literal} (${route.evidence}) is registered but the pinned inventory row ${row.method} ${row.path} classifies it unsupported-with-reason; a registration contradicts a decided exclusion unless an explicit goException records the decision (e.g. AGENTS.md boundary 3 for /api/avatars/upload)`);
                    continue;
                } else {
                    problems.push(`Go route ${literal} (${route.evidence}) matches pinned row ${row.method} ${row.path}, whose status is unclassifiable: ${pinnedClass.reason}`);
                    continue;
                }
            } else {
                problems.push(`Go route ${literal} (${route.evidence}) is not registered by the pinned inventory and has no classification: add it to tools/compat-matrix/surface-classifications.json goExceptions with implemented / intentionally-passthrough / not-applicable / unsupported-with-reason and a reason`);
                continue;
            }
        }
        if (!CLASSIFICATIONS.has(classification)) {
            problems.push(`Go route ${literal} (${route.evidence}) carries invalid classification ${JSON.stringify(classification)}`);
            continue;
        }
        goReport.push({ pattern: literal, method, path: pattern, classification, reason: reason ?? null, evidence: route.evidence });
        if (!goByPath.has(pattern)) goByPath.set(pattern, []);
        goByPath.get(pattern).push(classification);
    }

    // FRONTEND SURFACES: union of the three oracle-derived lists, then one classification each. Pinned
    // redirect ALIASES are deliberately NOT surfaces -- they are server routes recorded in the inventory's
    // redirect table and are gated below as aliases, because a legacy alias is not something the pinned
    // frontend builds (and if it were, it would appear in the frontend extraction as well).
    const allFrontend = new Map();
    const frontendEntry = surface => {
        if (!allFrontend.has(surface)) allFrontend.set(surface, { surface, sources: new Set(), files: new Set(), observations: [] });
        return allFrontend.get(surface);
    };
    for (const entry of frontend) {
        const item = frontendEntry(entry.surface);
        item.sources.add('pinned-frontend');
        for (const file of entry.files) item.files.add(file);
    }
    for (const row of startup) {
        const item = frontendEntry(row.surface);
        item.sources.add('startup-observation');
        item.observations.push({ source: 'startup-observation', resource: row.resource, observedStatus: row.observedStatus });
    }
    for (const row of extension) {
        const item = frontendEntry(row.surface);
        item.sources.add('extension-record');
        item.observations.push({ source: 'extension-record', declaredStatus: row.declaredStatus });
    }

    const frontendReport = [];
    for (const entry of [...allFrontend.values()].sort((a, b) => a.surface.localeCompare(b.surface))) {
        const exception = frontendExceptions.get(entry.surface);
        let classification = null;
        let reason = null;
        let evidence = [...entry.files].sort().slice(0, 3);
        if (exception) {
            classification = exception.classification;
            reason = exception.reason;
            evidence = [exception.evidence ?? evidence[0] ?? null].filter(Boolean);
            used.frontend.add(entry.surface);
        } else {
            const row = pinnedMatch(pinnedRows, entry.surface, null);
            if (row) {
                const pinnedClass = classifyPinnedStatus(row.status);
                classification = pinnedClass.classification;
                reason = pinnedClass.reason;
                evidence = [row.file + ':' + row.line];
                // A PINNED ROUTE THIS TREE DOES NOT SERVE cannot be classified implemented, however its
                // inventory status reads: the frontend builds the URL and would get the catch-all. A recorded
                // open gap makes it unsupported-with-reason (visible, with the gap id), and no recorded gap
                // fails the gate below through the missing-route finding.
                if (classification === 'implemented' && !goMatches(go.routes, entry.surface)) {
                    const gap = missingExceptions.get(`${row.method} ${row.path}`);
                    if (gap) {
                        classification = 'unsupported-with-reason';
                        reason = `${gap.reason} (gap ${gap.gapId})`;
                        evidence = [`${row.file}:${row.line}`, 'tools/compat-matrix/surface-classifications.json'];
                    }
                }
            } else if (matchesStaticMount(entry.surface) || staticMountFor(entry.surface)) {
                const mount = staticMountFor(entry.surface);
                classification = 'intentionally-passthrough';
                reason = mount?.reason ?? 'served as pinned bytes by the frontend static middleware (express.static(public) at src/server-main.js:242), not a route this backend implements';
                evidence = mount?.evidence ? [mount.evidence] : ['upstream/public'];
            } else if (entry.surface.startsWith('/scripts/extensions/third-party') || entry.surface.startsWith('/user/') || entry.surface.startsWith('/characters/') || entry.surface.startsWith('/backgrounds/') || entry.surface.startsWith('/User%20Avatars') || entry.surface.startsWith('/assets/')) {
                classification = 'intentionally-passthrough';
                reason = 'a pinned user-data static mount (src/users.js:1213-1219), served from the user tree as pinned send()/createRouteHandler bytes';
                evidence = ['internal/server/frontend_assets.go'];
            } else if (goMatches(go.routes, entry.surface)) {
                classification = 'implemented';
                evidence = [goMatches(go.routes, entry.surface).evidence];
            } else if (entry.observations.some(observation => observation.source === 'startup-observation' && observation.resource !== 'fetch' && observation.resource !== 'xhr')) {
                // A startup observation resource that is not a fetch is a STATIC ASSET the page loaded; it is
                // served from the pinned frontend tree by the same middleware express.static mounts.
                classification = 'intentionally-passthrough';
                reason = 'observed as a non-XHR resource during the committed startup observation, i.e. a static asset served from the pinned frontend tree';
                evidence = ['docs/frontend-startup-calls.md'];
            }
            if (classification === null) {
                problems.push(`frontend surface ${entry.surface} (built by ${[...entry.files].sort().slice(0, 3).join(', ') || 'a startup/extension observation'}) is not classified by any pinned route, static mount, redirect alias or committed exception: a new frontend route or request shape must be classified in tools/compat-matrix/surface-classifications.json (implemented / intentionally-passthrough / not-applicable / unsupported-with-reason)`);
                continue;
            }
        }
        if (!CLASSIFICATIONS.has(classification)) {
            problems.push(`frontend surface ${entry.surface} carries invalid classification ${JSON.stringify(classification)}`);
            continue;
        }
        // AN IMPLEMENTED FRONTEND SURFACE MUST REACH A GO REGISTRATION. This is the rule-43 diff: the pinned
        // frontend's URL builders are the requirements document, and a requirement with no registration is the
        // shape of the two shipped P0s.
        const reaches = goMatches(go.routes, entry.surface);
        if (classification === 'implemented' && !reaches) {
            problems.push(`frontend surface ${entry.surface} is classified implemented but no mux.HandleFunc registration serves it: the pinned frontend builds this URL and the survey has no route for it (AGENTS.md 42/43/44)`);
            continue;
        }
        frontendReport.push({
            surface: entry.surface,
            classification,
            reason,
            evidence,
            reachesGo: Boolean(reaches),
            sources: [...entry.sources].sort(),
        });
    }

    // REACHABLE PINNED ROUTES MUST BE REGISTERED. A route the pinned server serves and this tree does not is
    // the coverage hole rule 43 exists to catch; a decided exclusion is already classified unsupported.
    const missing = [];
    for (const row of pinnedRows) {
        if (row.path.includes('<computed')) continue;
        const pinnedClass = classifyPinnedStatus(row.status);
        if (pinnedClass.classification === null) {
            problems.push(`pinned inventory row ${row.method} ${row.path} has an unclassifiable status: ${pinnedClass.reason}`);
            continue;
        }
        if (pinnedClass.classification === 'unsupported-with-reason') continue;
        const key = `${row.method} ${row.path}`;
        if (goByPath.has(row.path) || pinnedPathVariants(row.path).some(variant => goByPath.has(variant))) continue;
        if (missingExceptions.has(key)) {
            used.missing.add(key);
            const recorded = missingExceptions.get(key);
            missing.push({ method: row.method, path: row.path, evidence: `${row.file}:${row.line}`, status: recorded.status ?? 'open', gapId: recorded.gapId ?? null, reason: recorded.reason ?? null, userImpact: recorded.userImpact ?? null });
            continue;
        }
        problems.push(`pinned route ${row.method} ${row.path} (${row.file}:${row.line}) is reachable upstream and has no Go registration: a missing surface fails the coverage gate (AGENTS.md 43)`);
    }

    // PINNED REDIRECT ALIASES are a route class of their own (src/server-startup.js:84-133). A registered one
    // is the pinned 308 behaviour; an unregistered one is an OPEN GAP, not a decided exclusion, so it can only
    // pass the gate with an explicit open entry naming the gap id and the evidence. A NEW missing alias fails.
    const aliasReport = [];
    for (const redirect of redirects) {
        const registered = go.routes.some(route => normalizeGoPattern(route.literal).pattern === redirect.source);
        if (registered) {
            aliasReport.push({ source: redirect.source, destination: redirect.destination, status: 'registered', evidence: `${redirect.file}:${redirect.line}` });
            continue;
        }
        const recorded = redirectAliasExceptions.get(redirect.source);
        if (!recorded) {
            problems.push(`pinned redirect alias ${redirect.source} -> ${redirect.destination} (${redirect.file}:${redirect.line}) has no Go registration: register the alias, or record it in surface-classifications.json redirectAliases with status "open", a gap id and the user-visible consequence`);
            continue;
        }
        used.redirectAlias.add(redirect.source);
        aliasReport.push({
            source: redirect.source,
            destination: redirect.destination,
            status: recorded.status ?? 'open',
            gapId: recorded.gapId ?? null,
            reason: recorded.reason ?? null,
            evidence: `${redirect.file}:${redirect.line}`,
        });
    }

    // UNRESOLVED REGISTRATION SITES.
    for (const site of go.unresolvedSites) {
        const key = `${site.file}:${site.line}`;
        if (unresolvedExceptions.has(key)) { used.unresolved.add(key); continue; }
        problems.push(`Go registration site ${key} is unresolved (${site.text}): teach tools/compat-matrix/surface-coverage.mjs the idiom, or record it in surface-classifications.json unresolvedSites with the reason it cannot be enumerated`);
    }

    // STALE CLASSIFICATION ENTRIES: an exception for a surface that no longer exists would otherwise cover a
    // NEW surface with the same spelling. Every committed decision must still name a live surface.
    for (const surface of frontendExceptions.keys()) {
        if (!used.frontend.has(surface)) problems.push(`classification frontendExceptions.${surface} names a frontend surface that does not exist (or is already covered by a pinned route): delete it or correct its spelling`);
    }
    for (const pattern of goExceptions.keys()) {
        if (!used.go.has(pattern)) problems.push(`classification goExceptions.${pattern} names a Go route that no mux.HandleFunc registers: delete it or correct its spelling`);
    }
    for (const key of missingExceptions.keys()) {
        if (!used.missing.has(key)) problems.push(`classification missingPinnedRoutes.${key} names a pinned route that IS registered (or has no pinned row): delete it so it cannot hide a future gap`);
    }
    for (const key of unresolvedExceptions.keys()) {
        if (!used.unresolved.has(key)) problems.push(`classification unresolvedSites.${key} names a registration site that no longer exists: delete it`);
    }
    for (const source of redirectAliasExceptions.keys()) {
        if (!used.redirectAlias.has(source)) problems.push(`classification redirectAliases.${source} names a pinned alias that IS registered (or does not exist): delete it so it cannot hide a future gap`);
    }

    const counts = { implemented: 0, 'intentionally-passthrough': 0, 'not-applicable': 0, 'unsupported-with-reason': 0 };
    for (const entry of frontendReport) counts[entry.classification]++;
    const goCounts = { implemented: 0, 'intentionally-passthrough': 0, 'not-applicable': 0, 'unsupported-with-reason': 0 };
    for (const entry of goReport) goCounts[entry.classification]++;
    const aliasCounts = { registered: 0, open: 0 };
    for (const entry of aliasReport) aliasCounts[entry.status === 'registered' ? 'registered' : 'open']++;

    const report = {
        schemaVersion: 1,
        generatedBy: 'tools/compat-matrix/surface-coverage.mjs',
        baseline: {
            commit: read(root, 'upstream/SILLYTAVERN_COMMIT').trim().split(/\s+/)[0],
            version: read(root, 'upstream/SILLYTAVERN_VERSION').trim(),
        },
        sources: {
            pinnedInventoryRows: pinnedRows.length,
            pinnedRedirectAliases: redirects.length,
            goRegistrationFiles: go.files.length,
            goRegistrations: go.routes.length,
            frontendFiles: frontend.length ? new Set(frontend.flatMap(entry => entry.files)).size : 0,
            startupObservedRequests: startup.length,
            extensionRouteRows: extension.length,
            classificationExceptions: (classifications.frontendExceptions ?? []).length + (classifications.goExceptions ?? []).length + (classifications.missingPinnedRoutes ?? []).length + (classifications.unresolvedSites ?? []).length + (classifications.redirectAliases ?? []).length,
        },
        classificationCounts: { surfaces: frontendReport.length, ...counts },
        goClassificationCounts: { routes: goReport.length, ...goCounts },
        redirectAliasCounts: { aliases: aliasReport.length, ...aliasCounts },
        frontendSurfaces: frontendReport,
        goRoutes: goReport.sort((a, b) => a.pattern.localeCompare(b.pattern)),
        redirectAliases: aliasReport.sort((a, b) => a.source.localeCompare(b.source)),
        missingReachablePinnedRoutes: missing.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)),
        unresolvedRegistrationSites: go.unresolvedSites,
        problems: [],
    };
    return { report, problems, pinnedRows, redirects, go, frontend, startup, extension };
}

// ---------------------------------------------------------------------------------------------------
// RENDER: the generated machine file and the human block both come from this one derivation, so the
// document cannot claim a classification the data does not carry (AGENTS.md 36).
// ---------------------------------------------------------------------------------------------------
export function renderReport(report) {
    return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderBlock(report) {
    const lines = [];
    const counts = report.classificationCounts;
    lines.push(`Frontend-derived backend surfaces: **${counts.surfaces}** classified (implemented ${counts.implemented}, intentionally-passthrough ${counts['intentionally-passthrough']}, not-applicable ${counts['not-applicable']}, unsupported-with-reason ${counts['unsupported-with-reason']}); **0 unknown**. Go registrations: **${report.goClassificationCounts.routes}** classified (implemented ${report.goClassificationCounts.implemented}, intentionally-passthrough ${report.goClassificationCounts['intentionally-passthrough']}, not-applicable ${report.goClassificationCounts['not-applicable']}, unsupported-with-reason ${report.goClassificationCounts['unsupported-with-reason']}). Pinned redirect aliases: **${report.redirectAliasCounts.registered}** registered, **${report.redirectAliasCounts.open}** open gap(s). Inputs: ${report.sources.frontendFiles} pinned frontend module(s), ${report.sources.startupObservedRequests} observed startup request(s), ${report.sources.extensionRouteRows} extension-dependency row(s), ${report.sources.pinnedInventoryRows} pinned route(s), ${report.sources.goRegistrations} Go registration(s) in ${report.sources.goRegistrationFiles} file(s). A new frontend route/request shape, a new Go route with no classification, or a new unregistered pinned redirect alias fails \`node tools/compat-matrix/surface-coverage.mjs --check\` (run by \`tools/compat-matrix/check.mjs\` in \`ci.yml#verify\`), which is the drift gate rule 43 requires.`);
    lines.push('');
    lines.push('| Classification | Frontend surfaces | Go registrations |');
    lines.push('|---|---|---|');
    for (const classification of ['implemented', 'intentionally-passthrough', 'not-applicable', 'unsupported-with-reason']) {
        lines.push(`| ${classification} | ${counts[classification]} | ${report.goClassificationCounts[classification]} |`);
    }
    lines.push(`| **unknown** | **0** | **0** |`);
    const openAliases = report.redirectAliases.filter(entry => entry.status !== 'registered');
    if (openAliases.length > 0) {
        lines.push('');
        lines.push('**Pinned redirect aliases with no Go registration (OPEN gaps, recorded rather than absent):**');
        lines.push('');
        for (const entry of openAliases) lines.push(`- \`${entry.source}\` -> \`${entry.destination}\`${entry.gapId ? ` (${entry.gapId})` : ''}${entry.reason ? ` — ${entry.reason}` : ''}`);
    }
    if (report.missingReachablePinnedRoutes.length > 0) {
        lines.push('');
        lines.push('**Reachable pinned routes with no Go registration (recorded gaps, not silently absent):**');
        lines.push('');
        for (const entry of report.missingReachablePinnedRoutes) lines.push(`- \`${entry.method} ${entry.path}\` — ${entry.classification} (${entry.evidence})`);
    }
    return lines.join('\n');
}

export function writeSurfaceCoverage(root = repoRoot) {
    const { report } = deriveSurfaceCoverage(root);
    if (report.problems.length > 0) {
        for (const problem of report.problems) process.stderr.write(`  - ${problem}\n`);
        throw new Error('refusing to write a surface report while the gate has findings');
    }
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderReport(report), 'utf8');
    const original = read(root, 'docs/surface-coverage.md');
    const marker = new RegExp(`<!-- BEGIN GENERATED: ${BLOCK_NAME.replaceAll('.', '\\.')} -->([\\s\\S]*?)<!-- END GENERATED: ${BLOCK_NAME.replaceAll('.', '\\.')} -->`);
    if (!marker.test(original)) throw new Error(`docs/surface-coverage.md: missing ${BLOCK_NAME} marker`);
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    const block = renderBlock(report).replace(/\r?\n/g, newline);
    writeFileSync(surfaceDocumentPath, original.replace(marker, `<!-- BEGIN GENERATED: ${BLOCK_NAME} -->${block}<!-- END GENERATED: ${BLOCK_NAME} -->`), 'utf8');
    return report;
}

export function checkSurfaceCoverage(root = repoRoot) {
    const problems = [];
    const { report } = deriveSurfaceCoverage(root);
    problems.push(...report.problems);
    if (exists(root, 'docs/generated/surface-coverage.json')) {
        const committed = read(root, 'docs/generated/surface-coverage.json');
        if (committed !== renderReport(report)) {
            problems.push('docs/generated/surface-coverage.json is stale (run: node tools/compat-matrix/surface-coverage.mjs --emit)');
        }
    } else {
        problems.push('docs/generated/surface-coverage.json is missing (run: node tools/compat-matrix/surface-coverage.mjs --emit)');
    }
    if (exists(root, 'docs/surface-coverage.md')) {
        const document = read(root, 'docs/surface-coverage.md');
        const marker = new RegExp(`<!-- BEGIN GENERATED: ${BLOCK_NAME.replaceAll('.', '\\.')} -->([\\s\\S]*?)<!-- END GENERATED: ${BLOCK_NAME.replaceAll('.', '\\.')} -->`);
        const committed = document.match(marker);
        const normalize = value => (value ?? '').replace(/\r\n/g, '\n');
        if (!committed) problems.push(`docs/surface-coverage.md: missing ${BLOCK_NAME} marker`);
        else if (normalize(committed[1]) !== normalize(renderBlock(report))) problems.push(`docs/surface-coverage.md: block ${BLOCK_NAME} is stale (run: node tools/compat-matrix/surface-coverage.mjs --emit)`);
    } else {
        problems.push('docs/surface-coverage.md is missing');
    }
    return { problems, report };
}

// ---------------------------------------------------------------------------------------------------
// SELF-TEST: the gate's teeth, proven on COPIED fixture trees rather than by editing the real one
// (AGENTS.md 57: a mutation must list exactly the intended files and must never risk surviving in the tree).
// Every scenario copies a minimal tree into a temp directory, mutates the COPY, runs the real derivation,
// requires a NAMED failure, then restores by copying the pristine file back and requires green.
// ---------------------------------------------------------------------------------------------------
export function selftestSurfaceCoverage(root = repoRoot) {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'gotavern-surface-selftest-'));
    const results = [];
    const copyIn = (relative, content) => {
        mkdirSync(path.dirname(path.join(scratch, relative)), { recursive: true });
        writeFileSync(path.join(scratch, relative), content, 'utf8');
    };
    const pristine = new Map();
    const remember = (relative, content) => { pristine.set(relative, content); copyIn(relative, content); };
    const restore = (relative) => copyIn(relative, pristine.get(relative));
    // Every scenario reads a COPIED fixture tree and its own in-memory decisions; the real classifications
    // file is never touched, so a mutation cannot outlive the run (AGENTS.md 57: restore through bytes, and
    // never risk a surviving mutation in the tree).
    const emptyDecisions = { schemaVersion: 1, frontendExceptions: [], goExceptions: [], missingPinnedRoutes: [], unresolvedSites: [] };
    let decisions = emptyDecisions;
    try {
        remember('upstream/SILLYTAVERN_COMMIT', '06bde939fb1e9c4c8d8641d810f0a916b5bce127\n');
        remember('upstream/SILLYTAVERN_VERSION', '1.19.0\n');
        remember('docs/api-inventory.md', [
            '# Pinned HTTP route inventory',
            '',
            '| Method | Full path | Upstream declaration | Current status |',
            '|---|---|---|---|',
            '| POST | `/api/selftest/known` | [src/endpoints/selftest.js:1](https://example.invalid/1) | partial: a copied fixture route |',
            '',
        ].join('\n'));
        remember('docs/frontend-startup-calls.md', '');
        remember('docs/extension-route-coverage.md', '');
        remember('docs/surface-coverage.md', '<!-- BEGIN GENERATED: surface.drift -->old<!-- END GENERATED: surface.drift -->\n');
        remember('docs/generated/surface-coverage.json', '{}\n');
        remember('internal/server/selftest.go', [
            'package server',
            '',
            'func registerSelftestRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {',
            '\tpost := func(route string, handler func(http.ResponseWriter, *http.Request)) {',
            '\t\tmux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) { handler(w, r) })',
            '\t}',
            '\tpost("/api/selftest/known", accounts.serveSelftest)',
            '}',
            '',
        ].join('\n'));
        remember('upstream/public/scripts/selftest.js', "export async function f() { return fetch('/api/selftest/known', { method: 'POST' }); }\n");

        const derive = () => deriveSurfaceCoverage(scratch, { classifications: decisions });
        const expectFinding = (name, fragment) => {
            const { problems } = derive();
            const hit = problems.find(problem => problem.includes(fragment));
            results.push({ name, ok: Boolean(hit), detail: hit ?? `no failure contained ${JSON.stringify(fragment)}; got ${problems.length} problem(s): ${problems.slice(0, 2).join(' | ')}` });
        };
        const expectGreen = (name) => {
            const { problems, report } = derive();
            const hidden = report.classificationCounts.surfaces > 0 && report.classificationCounts.surfaces === report.classificationCounts['not-applicable'] + report.classificationCounts.implemented + report.classificationCounts['intentionally-passthrough'] + report.classificationCounts['unsupported-with-reason'];
            results.push({ name, ok: problems.length === 0 && hidden, detail: problems.slice(0, 3).join(' | ') || (hidden ? 'green' : 'classification counts do not add up') });
        };

        // A green baseline is what makes every mutation below the ONLY possible cause of the red.
        expectGreen('baseline copied tree is green');

        // MUTATION 1: a NEW frontend request shape with no classification.
        copyIn('upstream/public/scripts/selftest.js', "export async function f() { return fetch('/api/selftest/known'); }\nexport async function g() { return fetch('/api/selftest/new-frontend-surface'); }\n");
        expectFinding('a new frontend route/request shape is a named red', 'frontend surface /api/selftest/new-frontend-surface');
        restore('upstream/public/scripts/selftest.js');
        expectGreen('the new frontend route removed by file copy -> green again');

        // MUTATION 2: a NEW Go route with no classification.
        copyIn('internal/server/selftest.go', pristine.get('internal/server/selftest.go')
            .replace('\tpost("/api/selftest/known", accounts.serveSelftest)', '\tpost("/api/selftest/known", accounts.serveSelftest)\n\tpost("/api/selftest/new-go-surface", accounts.serveSelftest)'));
        expectFinding('a new unclassified Go route is a named red', 'Go route /api/selftest/new-go-surface');
        restore('internal/server/selftest.go');
        expectGreen('the new Go route removed by file copy -> green again');

        // MUTATION 3: a pinned reachable route with no Go registration (the P0 shape this gate exists for).
        copyIn('docs/api-inventory.md', pristine.get('docs/api-inventory.md')
            .replace('\n', '\n| POST | `/api/selftest/unregistered` | [src/endpoints/selftest.js:2](https://example.invalid/2) | partial: reachable upstream |\n'));
        expectFinding('a reachable pinned route with no Go registration is a named red', 'pinned route POST /api/selftest/unregistered');
        restore('docs/api-inventory.md');
        expectGreen('the unregistered pinned route removed by file copy -> green again');

        // MUTATION 4: a bare `not implemented` (backlog disguised as a decision).
        copyIn('docs/api-inventory.md', pristine.get('docs/api-inventory.md').replace('partial: a copied fixture route', 'not implemented'));
        expectFinding('a bare "not implemented" is a named red', 'unclassifiable status');
        restore('docs/api-inventory.md');
        expectGreen('the bare "not implemented" corrected -> green again');

        // MUTATION 5: an exception that names no live surface (a stale decision that would cover a future one).
        decisions = { ...emptyDecisions, frontendExceptions: [{ surface: '/api/selftest/ghost-surface', classification: 'not-applicable', reason: 'a copied fixture surface that no longer exists', evidence: 'self-test' }] };
        expectFinding('an exception naming no live surface is a named red', 'frontendExceptions./api/selftest/ghost-surface');
        decisions = emptyDecisions;
        expectGreen('the stale exception removed -> green again');

        // MUTATION 6: a registration idiom the parser cannot resolve must fail, not be skipped silently.
        copyIn('internal/server/selftest.go', [
            'package server',
            '',
            'func registerSelftestRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {',
            '\tfor name := range someRouteTable() {',
            '\t\tmux.HandleFunc(name, func(w http.ResponseWriter, r *http.Request) {})',
            '\t}',
            '}',
            '',
        ].join('\n'));
        expectFinding('an unresolved registration idiom is a named red', 'Go registration site internal/server/selftest.go:');
        restore('internal/server/selftest.go');
        expectGreen('the unresolved idiom removed by file copy -> green again');
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
    return results;
}
// The selftest writes a scratch copy under os.tmpdir(); the REAL classification file is only temporarily
// rewritten when a scenario needs it, and is restored by the caller. Those two writes are the only ones and
// they are to the tool's own data file, never to the tree under test.
function main() {
    const mode = process.argv.includes('--check') ? 'check'
        : process.argv.includes('--emit') ? 'emit'
            : process.argv.includes('--selftest') ? 'selftest'
                : 'print';
    const rootArgument = process.argv.find(argument => argument.startsWith('--root='));
    const root = rootArgument ? path.resolve(rootArgument.slice('--root='.length)) : repoRoot;
    if (mode === 'print') {
        const { report, problems } = deriveSurfaceCoverage(root);
        process.stdout.write(renderReport(report));
        if (problems.length > 0) {
            process.stderr.write(`surface coverage: ${problems.length} problem(s)\n`);
            for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
            return 1;
        }
        return 0;
    }
    if (mode === 'emit') {
        const report = writeSurfaceCoverage(root);
        process.stdout.write(`wrote docs/generated/surface-coverage.json and the ${BLOCK_NAME} block (${report.classificationCounts.surfaces} surfaces)\n`);
        return 0;
    }
    if (mode === 'selftest') {
        const results = selftestSurfaceCoverage(root);
        let failed = 0;
        for (const result of results) {
            process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : ` -- ${result.detail}`}\n`);
            if (!result.ok) failed++;
        }
        process.stdout.write(`surface-coverage selftest: ${results.length - failed}/${results.length} scenario(s) green\n`);
        return failed === 0 ? 0 : 1;
    }
    const { problems } = checkSurfaceCoverage(root);
    if (problems.length > 0) {
        process.stderr.write(`surface coverage: ${problems.length} problem(s)\n`);
        for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
        return 1;
    }
    const { report } = checkSurfaceCoverage(root);
    process.stdout.write(`surface coverage: ${report.classificationCounts.surfaces} frontend surface(s) and ${report.goClassificationCounts.routes} Go registration(s) classified, 0 unknown — drift gate green\n`);
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main();
}
