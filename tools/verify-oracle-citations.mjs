#!/usr/bin/env node
// Fail when a compatibility document cites an oracle fixture that does not exist.
//
// AGENTS.md rule 18 forbids claiming compatibility that was not demonstrated.
// A cited-but-missing tests/oracle/*.json fixture is the cheapest way for that
// to happen silently, so this check makes the evidence chain mechanically
// verifiable instead of a matter of reviewer diligence.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DOCUMENTS = [
    'docs/compat-matrix.md',
    'docs/api-inventory.md',
    'docs/startup-inventory.md',
    'docs/config-inventory.md',
    'docs/extension-route-coverage.md',
    'docs/SEMANTIC-COMPATIBILITY.md',
    'ARCHITECTURE.md',
    'README.md',
];

// Matches fixture paths mentioned with or without the tests/oracle/ prefix so a
// short-form citation cannot dodge the check.
const FIXTURE_PATTERN = /tests\/oracle\/([A-Za-z0-9._-]+\.json)/g;

const problems = [];
let citations = 0;

for (const document of DOCUMENTS) {
    const documentPath = path.join(repositoryRoot, document);
    if (!existsSync(documentPath)) continue;
    const contents = readFileSync(documentPath, 'utf8');
    const lines = contents.split(/\r?\n/);
    lines.forEach((line, index) => {
        for (const match of line.matchAll(FIXTURE_PATTERN)) {
            citations += 1;
            const relative = path.posix.join('tests/oracle', match[1]);
            if (!existsSync(path.join(repositoryRoot, relative))) {
                problems.push(`${document}:${index + 1} cites missing fixture ${relative}`);
            }
        }
    });
}

if (problems.length > 0) {
    console.error('Documentation cites oracle fixtures that are not committed:\n');
    for (const problem of problems) console.error('  ' + problem);
    console.error(`\n${problems.length} dangling fixture citation(s); ${citations} citation(s) checked.`);
    console.error('Either commit the fixture that the probe generates, or remove the compatibility claim.');
    process.exit(1);
}

console.log(`Oracle fixture citations resolve: ${citations} citation(s) across ${DOCUMENTS.length} document(s).`);
