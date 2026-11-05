#!/usr/bin/env node
// INSTALL THE 20 PINNED THIRD-PARTY EXTENSIONS INTO A LONG-LIVED DATA ROOT.
//
// WHY THIS FILE EXISTS. `internal/longlivedfixture` builds the years-old-shaped instance, but the
// 20 real third-party extensions are third-party repositories pinned by COMMIT in
// `tests/browser/third-party-extensions.lock.json`; they are NOT committed here (their licences and
// sizes differ, and rule 56 keeps third-party payloads out of the tree). The lock is the pin, and this
// script materialises them the way the pinned install route would: a git checkout at the pinned
// revision inside `<dataRoot>/default-user/extensions/<name>` (see tests/browser/install-pinned-extension.mjs).
//
// WHAT IT WRITES. The extensions, plus a MANIFEST at `--out` recording each name, repo, pinned commit,
// installed revision, file count and the sha256 of its manifest.json. The manifest is what the Go test
// compares against; extension CONTENT is never printed and never leaves the CI runner.
//
// SFW BOUNDARY. These are third-party sources fetched into a temporary data root only for the duration
// of a CI job. Nothing here uploads them, commits them or prints their text; the manifest carries only
// names, pins, counts and digests.
//
// Usage:
//   node tools/longlived/install-pinned-extensions.mjs --data-root <dir> [--out <manifest.json>]

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
    ensurePinnedExtensionInstalled,
    describeInstalledExtension,
    userExtensionsDirectory,
} from '../../tests/browser/install-pinned-extension.mjs';
import { loadLock, EXPECTED_SELECTED } from '../../tests/browser/third-party-extensions.mjs';

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

async function main() {
    const dataRootArgument = argument('--data-root');
    if (!dataRootArgument) {
        console.error('install-pinned-extensions.mjs: --data-root is required');
        process.exit(2);
    }
    const dataRoot = path.resolve(dataRootArgument);
    const out = path.resolve(argument('--out', path.join(dataRoot, 'pinned-extensions.manifest.json')));
    const { lock, sha256: lockSha256, path: lockPath, bytes: lockBytes } = loadLock();
    if (lock.selected.length !== EXPECTED_SELECTED) {
        throw new Error(`the lock carries ${lock.selected.length} extensions, expected ${EXPECTED_SELECTED}`);
    }
    const extensionsRoot = userExtensionsDirectory(dataRoot);
    await fs.mkdir(extensionsRoot, { recursive: true });

    const installed = [];
    for (const extension of lock.selected) {
        const result = await ensurePinnedExtensionInstalled(dataRoot, extension);
        const described = await describeInstalledExtension(result.extensionDirectory);
        const manifestBytes = await fs.readFile(path.join(result.extensionDirectory, 'manifest.json'));
        installed.push({
            name: extension.name,
            repo: extension.repo,
            commit: extension.commit,
            revision: result.revision,
            manifestPresent: described.manifestPresent,
            manifestDisplayName: described.manifestDisplayName,
            manifestVersion: described.manifestVersion,
            files: described.fileCount,
            manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        });
    }

    const document = {
        schema: 'gotavern-longlived-pinned-extensions',
        schemaVersion: 1,
        lock: { path: path.relative(process.cwd(), lockPath), sha256: lockSha256, bytes: lockBytes },
        expected: EXPECTED_SELECTED,
        installed: installed.length,
        extensions: installed,
    };
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: installed.length === EXPECTED_SELECTED, installed: installed.length, out: path.relative(process.cwd(), out) }));
}

main().catch(error => {
    console.error(`install-pinned-extensions.mjs failed: ${error?.message ?? error}`);
    process.exit(1);
});
