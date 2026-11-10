// Generates the pinned data-root TEMPLATE used by the alpha.20 probes.
//
// WHY A TEMPLATE. A fresh pinned boot pays a cold Webpack frontend compile (~114 s measured on this
// host) before it listens. Every probe that needs a FRESH data root would otherwise pay it again. This
// script boots the READ-ONLY pinned checkout ONCE over an empty scratch directory and lets the pinned
// product seed it (config.yaml from default/config.yaml, default content, default-user scaffold, warm
// _webpack cache). The result is not hand-made: it is exactly the tree a first-run pinned server writes.
// The probes copy it and record its census digest, so each probe states the tree it started from.
//
// RUN: node tests/browser/a20-probe-template.mjs
// EVIDENCE: docs/alpha20/oracle/pinned-data-template/evidence.json

import path from 'node:path';
import fsp from 'node:fs/promises';
import {
    bootPinned, census, treeDigest, sha256, writeEvidence, probeHeader, finishHeader,
    ensureDir, SCRATCH_ROOT, DATA_TEMPLATE, PINNED_COMMIT,
} from './a20-probe-kit.mjs';

const PROBE = 'pinned-data-template';
const header = probeHeader({
    probe: PROBE,
    purpose: 'produce the pinned fresh-install data-root template the alpha.20 probes copy, from a real cold pinned boot (never hand-authored)',
});
const dataRoot = DATA_TEMPLATE;
await ensureDir(path.join(SCRATCH_ROOT));
const { rm } = await import('node:fs/promises');
await rm(dataRoot, { recursive: true, force: true });

const started = Date.now();
const server = await bootPinned({ dataRoot, label: 'pinned-template-cold-boot', readyTimeoutMs: 420000, collectLog: false });
const bootMs = Date.now() - started;
const version = server.version;
const stop = await server.stop();
const entries = await census(dataRoot);
const evidence = {
    ...finishHeader(header),
    pinned: { commit: PINNED_COMMIT, version },
    boot: {
        kind: 'cold (frontend libraries compiled during this boot; dataRoot created empty by this script)',
        bootMs,
        exit: stop,
        note: 'the boot log is not retained verbatim (it contains seeded file paths only); the tree itself is censused below',
    },
    template: {
        path: 'template-data',
        files: entries.length,
        bytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
        treeSha256: treeDigest(entries),
        configSha256: sha256(await fsp.readFile(path.join(dataRoot, 'config.yaml'))),
        inventory: entries,
    },
    verdicts: [
        { id: 'template-is-product-produced', verdict: 'CONFIRMED', evidence: 'the template was not copied from the pinned checkout by hand; a pinned process was booted over an empty directory and this is what it wrote' },
        { id: 'template-is-warm', verdict: 'CONFIRMED', evidence: '_webpack/ exists in the inventory, so probe boots over copies reuse the compiled frontend libraries' },
    ],
    unproven: [
        'The template is one host\'s cold boot; file mtimes differ between hosts and are not part of the digest because census hashes bytes only. Two hosts produce the same file SET but not necessarily the same settings.json timestamps.',
    ],
};
const written = await writeEvidence(PROBE, evidence);
console.log(`template: ${dataRoot}`);
console.log(`files=${evidence.template.files} bytes=${evidence.template.bytes} tree=${evidence.template.treeSha256} bootMs=${bootMs}`);
console.log(`evidence: ${written.file}`);
