#!/usr/bin/env node
// Serialise pinned-server boots across concurrent probe runs.
//
// WHY THIS EXISTS. Every probe boots the pinned server through tools/lib/pinned-outbound.mjs, and the
// pinned server compiles the whole frontend before it listens (`src/server-main.js:354` calls
// `webpackMiddleware.runWebpackCompiler({ pruneCache: true })`, unconditionally, in the SHARED
// checkout). Two probe processes booting at once therefore run two pruned webpack compiles against
// the same output directory: the second one's readiness deadline expires while the first is still
// compiling, and the probe dies with `pinned server did not become ready: TypeError: fetch failed`.
// That failure is a property of the HOST's CPU and of how many lanes happen to be probing, not of the
// route under test, so it must never be allowed to look like a product finding or a probe defect.
//
// Measured on the development host with several lanes probing at once: 115.9 s, 138.2 s, then a miss
// past the 180 s deadline on three consecutive attempts, all before a single scenario ran.
//
// WHAT IT DOES NOT DO. It does not touch the pinned checkout, does not shorten any deadline and does
// not retry a probe's scenarios. It only makes the boots take turns, so a recorded fixture always
// comes from one uninterrupted compile.
//
// USAGE -- `run` is the mode to use, because the lock must be held by a LIVE process:
//
//     node tools/pinned-boot-lock.mjs run -- node tools/probe-<name>.mjs ..\SillyTavern .
//
// `run` holds the lock in this process, spawns the probe with inherited stdio (so the probe's own
// output is never captured and re-derived), and releases in a finally, including on a non-zero exit
// or a signal. The probe's exit status becomes this process's exit status.
//
// `acquire` / `release` exist for a human driving a shell by hand. They are NOT usable as a pair
// across two commands: `acquire` exits, so its pid is gone by the time `release` runs, and a lock
// whose owner pid is dead is (correctly) taken over by the next lane. That is not a bug in the lock;
// it is why `run` is the documented mode. A lock left behind by a crashed holder is taken over when
// its owner pid is gone or it is older than STALE_MS, and the takeover is logged with the reason,
// because a silent takeover is how a lock turns into decoration.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// THE LOCK LIVES IN THE SHARED GIT DIRECTORY, NOT IN THE CHECKOUT.
//
// Lanes work in their own `git worktree`, so a per-checkout lock would be one lock per lane and the
// whole point -- serialising the pinned server's pruned webpack compile -- would be lost while still
// LOOKING enforced. Every worktree of a repository shares one git common dir, so the lock is placed
// there. Outside a git checkout it falls back to the checkout root, which is the pre-worktree
// behaviour.
function lockParentDirectory(repositoryRootPath) {
    try {
        const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
            cwd: repositoryRootPath,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (common !== '') {
            return path.resolve(repositoryRootPath, common);
        }
    } catch {
        // Not a git checkout (or no git on PATH): the checkout root is the only shared place.
    }
    return repositoryRootPath;
}

const lockDirectory = path.join(lockParentDirectory(repositoryRoot), 'pinned-boot-lock');
const ownerFile = path.join(lockDirectory, 'owner.json');
const STALE_MS = 40 * 60 * 1000;
const DEFAULT_WAIT_SECONDS = 3600;

function readOwner() {
    try {
        return JSON.parse(readFileSync(ownerFile, 'utf8'));
    } catch {
        return null;
    }
}

function ownerIsGone(owner) {
    if (!owner || typeof owner.pid !== 'number') {
        return true;
    }
    try {
        process.kill(owner.pid, 0);
        return false;
    } catch (error) {
        return error.code === 'ESRCH';
    }
}

function describe(owner) {
    if (!owner) return 'owner unknown (no owner.json)';
    return `pid ${owner.pid} on ${owner.host} since ${new Date(owner.acquiredAt).toISOString()} (${owner.subject ?? 'unlabelled'})`;
}

function acquire(waitSeconds, subject) {
    const deadline = Date.now() + waitSeconds * 1000;
    let announced = false;
    for (;;) {
        try {
            mkdirSync(lockDirectory);
            writeFileSync(ownerFile, JSON.stringify({
                pid: process.pid,
                host: os.hostname(),
                acquiredAt: Date.now(),
                subject,
            }));
            return true;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }

        const owner = readOwner();
        let age = 0;
        try {
            age = Date.now() - statSync(lockDirectory).mtimeMs;
        } catch {
            continue;
        }
        if (age > STALE_MS || ownerIsGone(owner)) {
            console.error(`pinned-boot-lock: taking over a stale lock -- age ${Math.round(age / 1000)}s, ${describe(owner)}`);
            try {
                rmSync(lockDirectory, { recursive: true, force: true });
            } catch {
                // A concurrent takeover won the race; the next iteration observes its lock.
            }
            continue;
        }
        if (Date.now() > deadline) {
            console.error(`pinned-boot-lock: timed out after ${waitSeconds}s waiting for ${describe(owner)}`);
            return false;
        }
        if (!announced) {
            console.error(`pinned-boot-lock: waiting for ${describe(owner)}`);
            announced = true;
        }
        // Synchronous sleep: this is a CLI gate, not a server. Atomics.wait is the portable one.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
}

function release() {
    const owner = readOwner();
    if (owner && owner.pid !== process.pid) {
        console.error(`pinned-boot-lock: not releasing a lock held by ${describe(owner)}`);
        return false;
    }
    rmSync(lockDirectory, { recursive: true, force: true });
    return true;
}

function runCommand(argv, waitSeconds) {
    const separator = argv.indexOf('--');
    const command = separator === -1 ? argv : argv.slice(separator + 1);
    if (command.length === 0) {
        console.error('usage: node tools/pinned-boot-lock.mjs run [--wait <seconds>] -- <command> [args...]');
        return 2;
    }
    const subject = command.slice(0, 2).join(' ');
    if (!acquire(waitSeconds, subject)) {
        return 1;
    }
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
    const finish = code => {
        release();
        process.exit(code ?? 1);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, () => {
            child.kill(signal);
            release();
            process.exit(1);
        });
    }
    child.on('error', error => {
        console.error(`pinned-boot-lock: cannot start ${command[0]}: ${error.message}`);
        finish(1);
    });
    child.on('exit', code => finish(code ?? 1));
    return null;
}

const argv = process.argv.slice(2);
const command = argv[0];
if (command === 'run') {
    const waitIndex = argv.indexOf('--wait');
    const waitSeconds = waitIndex === -1 ? DEFAULT_WAIT_SECONDS : Number(argv[waitIndex + 1] ?? DEFAULT_WAIT_SECONDS);
    const exitCode = runCommand(argv, Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : DEFAULT_WAIT_SECONDS);
    if (exitCode !== null) {
        process.exit(exitCode);
    }
} else if (command === 'acquire') {
    const waitSeconds = Number(argv[1] ?? DEFAULT_WAIT_SECONDS);
    process.exit(acquire(Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : DEFAULT_WAIT_SECONDS,
        process.env.GOTAVERN_PROBE_LOCK_SUBJECT ?? 'manual acquire') ? 0 : 1);
} else if (command === 'release') {
    process.exit(release() ? 0 : 1);
} else {
    console.error('usage: node tools/pinned-boot-lock.mjs run [--wait <seconds>] -- <command> [args...]');
    console.error('       node tools/pinned-boot-lock.mjs acquire [waitSeconds] | release   (human use only)');
    process.exit(2);
}
