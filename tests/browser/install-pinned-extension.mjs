// Install one pinned extension revision into a data root the way an installed
// extension looks on disk, and report what was installed.
//
// The pinned install route clones into <dataRoot>/<handle>/extensions/<name> with
// `git clone --depth 1`, so this produces the same shape: a git checkout at the
// pinned revision, in the per-user extensions directory, with the repository's
// own manifest.json. Nothing here is extension-specific.
//
// `git fetch --depth 1 origin <sha>` fetches a single pinned commit rather than
// the whole history, which keeps the install cheap and makes the revision
// explicit instead of depending on a branch head that moves.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function run(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = [];
        child.stdout.on('data', chunk => output.push(chunk.toString()));
        child.stderr.on('data', chunk => output.push(chunk.toString()));
        child.on('error', reject);
        child.on('close', code => code === 0
            ? resolve(output.join(''))
            : reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${output.join('').slice(-2000)}`)));
    });
}

async function exists(target) {
    return fs.stat(target).then(() => true, () => false);
}

// The per-user extensions directory, matching startup.DirectoriesForUser and the
// pinned getUserDirectories: <dataRoot>/<handle>/extensions.
export function userExtensionsDirectory(dataRoot, handle = 'default-user') {
    return path.join(dataRoot, handle, 'extensions');
}

export async function installedRevision(extensionDirectory) {
    if (!(await exists(path.join(extensionDirectory, '.git')))) {
        return null;
    }
    try {
        return (await run('git', ['rev-parse', 'HEAD'], extensionDirectory)).trim();
    } catch {
        return null;
    }
}

// Idempotent: an existing checkout at the requested revision is left alone, so
// the two legs of a comparison share one installed tree rather than each cloning.
export async function ensurePinnedExtensionInstalled(dataRoot, extension) {
    const extensionsRoot = userExtensionsDirectory(dataRoot);
    const extensionDirectory = path.join(extensionsRoot, extension.name);
    const current = await installedRevision(extensionDirectory);
    if (current === extension.commit) {
        return { extensionDirectory, revision: current, installed: false };
    }
    if (current !== null) {
        // A checkout at the wrong revision is a harness defect, not something to
        // silently repair by deleting: the caller asked for a pinned revision.
        throw new Error(`${extensionDirectory} is at ${current}, not the pinned ${extension.commit}`);
    }
    if (await exists(extensionDirectory)) {
        await fs.rm(extensionDirectory, { recursive: true, force: true });
    }
    await fs.mkdir(extensionDirectory, { recursive: true });
    await run('git', ['init', '--quiet'], extensionDirectory);
    await run('git', ['remote', 'add', 'origin', extension.repo], extensionDirectory);
    await run('git', ['fetch', '--depth', '1', 'origin', extension.commit], extensionDirectory);
    // A NAMED branch, not a detached HEAD. The pinned install route clones a
    // branch, and /api/extensions/update derives the current branch from
    // `git branch`: on a detached HEAD that is empty, so the route fails with 500
    // on a tree that a user's own install would have updated cleanly. Recording a
    // leg against a detached checkout would measure a shape no user has.
    await run('git', ['checkout', '--quiet', '-B', extension.branch ?? 'main', 'FETCH_HEAD'], extensionDirectory);
    const revision = await installedRevision(extensionDirectory);
    if (revision !== extension.commit) {
        throw new Error(`installed ${extension.name} at ${revision}, not the pinned ${extension.commit}`);
    }
    return { extensionDirectory, revision, installed: true };
}

// What the installed tree contains, so a leg records WHICH revision it measured
// rather than only that something was installed.
export async function describeInstalledExtension(extensionDirectory) {
    const manifestPath = path.join(extensionDirectory, 'manifest.json');
    let manifest = null;
    try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
        manifest = null;
    }
    let fileCount = 0;
    const walk = async directory => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            const child = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(child);
            } else {
                fileCount += 1;
            }
        }
    };
    await walk(extensionDirectory);
    return {
        manifestPresent: manifest !== null,
        manifestDisplayName: typeof manifest?.display_name === 'string' ? manifest.display_name : null,
        manifestVersion: typeof manifest?.version === 'string' ? manifest.version : null,
        fileCount,
    };
}

if (process.argv[1] && process.argv[1].endsWith('install-pinned-extension.mjs')) {
    const { pinnedExtension } = await import('./pinned-extensions.mjs');
    const argumentValue = name => {
        const index = process.argv.indexOf(name);
        return index === -1 ? null : process.argv[index + 1];
    };
    const key = argumentValue('--extension');
    const dataRoot = argumentValue('--data-root');
    if (!key || !dataRoot) {
        console.error('usage: node install-pinned-extension.mjs --extension <key> --data-root <dir>');
        process.exit(2);
    }
    const extension = pinnedExtension(key);
    const result = await ensurePinnedExtensionInstalled(dataRoot, extension);
    const described = await describeInstalledExtension(result.extensionDirectory);
    console.log(JSON.stringify({ extension: key, name: extension.name, commit: extension.commit, ...result, ...described }, null, 2));
}
