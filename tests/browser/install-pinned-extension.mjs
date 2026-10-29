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

// THE PIN MUST NOT BE ABLE TO MOVE, AND THE INSTALL IS WHERE THAT IS GUARANTEED.
//
// MEASURED IN Browser differential 40878005589, and it made the pinned subject unpinnable mid-comparison: a probe leg
// installed 酒馆助手 at 837a6288…, the page then AUTO-UPDATED it to e71c9906… (the remote head) while the leg was
// running, and the restart invocation refused because the checkout was no longer the pinned commit. The pinned chain is
// `extensions.autoUpdate` defaulting to true (src/endpoints/settings.js:15) -> `enable_extensions_auto_update`
// (public/script.js:8022) -> `autoUpdateExtensions` on a version change (public/scripts/extensions.js:1809-1810) ->
// POST /api/extensions/update -> `git.fetch('origin')` + `git.pull('origin', branch)`
// (src/endpoints/extensions.js:193-206). With `origin` at github.com that pull moves the checkout.
//
// SO THE ORIGIN BECOMES A LOCAL, IMMUTABLE MIRROR OF THE PINNED CHECKOUT ITSELF: a bare clone inside the DATA ROOT
// (`<dataRoot>/.pinned-extension-origins/<name>.git`), whose HEAD and only branch are the pinned commit. The update
// route still runs git against a real remote -- fetch and version check are genuine -- but the fetch is local, a pull
// can only ever be a no-op, and NO REQUEST LEAVES THE PROCESS (AGENTS.md 14). This is the seed design
// (`GOTAVERN_EXTENSION_SEED_ROOT`) made unconditional: it used to depend on an env var the workflows never set, so the
// network origin survived into every leg. It works OFFLINE because the mirror is cloned from the checkout already on
// disk, and it is ASSERTED twice: here (the mirror's HEAD must equal the pin) and by the caller at the start and the
// end of its drive, so a moving checkout fails a named step instead of silently measuring a different extension.
async function ensureFrozenOrigin(dataRoot, extensionDirectory, commit) {
    const originRoot = path.join(dataRoot, '.pinned-extension-origins');
    const mirror = path.join(originRoot, `${path.basename(extensionDirectory)}.git`);
    await fs.mkdir(originRoot, { recursive: true });
    const headOf = directory => run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], directory)
        .then(value => value.trim(), () => null);
    if (await headOf(mirror) !== commit) {
        await fs.rm(mirror, { recursive: true, force: true });
        await run('git', ['clone', '--bare', '--quiet', extensionDirectory, mirror], originRoot);
        const cloned = await headOf(mirror);
        if (cloned !== commit) {
            throw new Error(`the frozen origin ${mirror} is at ${cloned}, not the pinned ${commit}`);
        }
    }
    await run('git', ['remote', 'set-url', 'origin', mirror], extensionDirectory);
    const revision = await headOf(extensionDirectory);
    if (revision !== commit) {
        throw new Error(`freezing the origin of ${extensionDirectory} left it at ${revision}, not the pinned ${commit}`);
    }
    return { origin: 'a local bare mirror of this checkout inside the data root (offline, cannot advance)', revision };
}

// Idempotent: an existing checkout at the requested revision is left alone, so
// the two legs of a comparison share one installed tree rather than each cloning.
// source in the result says how the tree got there ('seed', 'remote' or 'existing'), so an
// artifact can state whether the run touched the network.
export async function ensurePinnedExtensionInstalled(dataRoot, extension) {
    const extensionsRoot = userExtensionsDirectory(dataRoot);
    const extensionDirectory = path.join(extensionsRoot, extension.name);
    const current = await installedRevision(extensionDirectory);
    if (current === extension.commit) {
        return { extensionDirectory, revision: current, installed: false, source: 'existing', remote: 'local-mirror', frozen: await ensureFrozenOrigin(dataRoot, extensionDirectory, extension.commit) };
    }
    if (current !== null) {
        // A checkout at the wrong revision is a harness defect, not something to
        // silently repair by deleting: the caller asked for a pinned revision.
        throw new Error(`${extensionDirectory} is at ${current}, not the pinned ${extension.commit}`);
    }
    if (await exists(extensionDirectory)) {
        await fs.rm(extensionDirectory, { recursive: true, force: true });
    }
    // A FORCED-COMMIT SEED: GOTAVERN_EXTENSION_SEED_ROOT names a directory whose children are
    // extension checkouts (an extensions root, so a root from an earlier recording can be reused).
    // A copy from it is deterministic and needs no network, while a fetch from github.com makes this
    // gate depend on a third party being reachable. A seed at the WRONG revision is a harness defect
    // and throws, exactly like a wrong-revision checkout already sitting in the data root.
    const seedRoot = process.env.GOTAVERN_EXTENSION_SEED_ROOT;
    if (seedRoot) {
        const seedDirectory = path.join(path.resolve(seedRoot), extension.name);
        const seedRevision = await installedRevision(seedDirectory);
        if (seedRevision !== null && seedRevision !== extension.commit) {
            throw new Error('seed ' + seedDirectory + ' is at ' + seedRevision + ', not the pinned ' + extension.commit);
        }
        if (seedRevision === extension.commit) {
            await fs.mkdir(extensionsRoot, { recursive: true });
            await fs.cp(seedDirectory, extensionDirectory, { recursive: true });
            const copied = await installedRevision(extensionDirectory);
            if (copied !== extension.commit) {
                throw new Error('copied seed ' + seedDirectory + ' to ' + extensionDirectory + ' but it is at ' + copied);
            }
            // THE SEED AND THE FRESH CLONE GET THE SAME TREATMENT: the origin is frozen to a local mirror, so a
            // page-triggered update cannot advance either one (see ensureFrozenOrigin).
            return { extensionDirectory, revision: copied, installed: true, source: 'seed', remote: 'local-mirror', frozen: await ensureFrozenOrigin(dataRoot, extensionDirectory, extension.commit) };
        }
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
    return { extensionDirectory, revision, installed: true, source: 'remote', remote: 'local-mirror', frozen: await ensureFrozenOrigin(dataRoot, extensionDirectory, extension.commit) };
}

// What the installed tree contains, so a leg records WHICH revision it measured
// rather than only that something was installed. (The origin freeze that used to live here as an
// env-var-conditional step is now unconditional in ensureFrozenOrigin, above.)
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
