// Put the SAME config file in front of both legs, from the pinned default.
//
// WHY THIS EXISTS. The probe used to spawn each server with `cwd` set to its own checkout, so
// `gotavern start` resolved `config.yaml` against THIS REPOSITORY (a development config that
// happens to be lying around) while the pinned server resolved it against the pinned checkout.
// Two different files, in a domain where the file decides `enableUserAccounts`, CORS, the
// extension feature guard and the whitelist — so any difference in the anonymity of requests
// (which is one of the things the pair is supposed to measure) would have been a property of two
// configs rather than of two servers.
//
// Each leg therefore gets its OWN copy (shared mutable state is what produced the /css/user.css
// false difference: the first leg wrote, the second leg served), seeded from one source and
// recorded with its digest, so the comparison can refuse a pair that did not start from the same
// bytes.
//
// The source is `upstream/default/config.yaml`, which is the pinned fresh-install config — the
// same document a release install is seeded from.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(here, '..', '..');
export const PINNED_DEFAULT_CONFIG = path.join(repositoryRoot, 'upstream', 'default', 'config.yaml');

/**
 * Copies the pinned default config into `dataRoot` and returns what was seeded.
 *
 * `path` is relative on purpose: the absolute path is host-dependent and must never reach an
 * artifact, while the digest is what makes two legs provably identical.
 */
export async function seedLegConfig(dataRoot) {
    const body = await fs.readFile(PINNED_DEFAULT_CONFIG);
    const target = path.join(dataRoot, 'config.yaml');
    await fs.writeFile(target, body);
    const written = await fs.readFile(target);
    return {
        path: 'config.yaml',
        source: 'upstream/default/config.yaml',
        sha256: createHash('sha256').update(written).digest('hex'),
        matchesSource: createHash('sha256').update(body).digest('hex')
            === createHash('sha256').update(written).digest('hex'),
    };
}
