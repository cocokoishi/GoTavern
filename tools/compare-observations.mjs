#!/usr/bin/env node
// Compare two structured Node/Go observer captures without broad normalization.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const observers = ['http', 'provider', 'providerResponse', 'browserEvents', 'filesystem'];

export function compareObservations(reference, candidate) {
    const compared = [];
    const skipped = [];
    const differences = [];

    for (const name of observers) {
        const left = reference?.[name];
        const right = candidate?.[name];
        if (left === undefined || right === undefined) {
            differences.push({ path: `$.${name}`, reference: left, candidate: right, reason: 'observer missing from one capture' });
            continue;
        }
        const leftObserved = left?.observed !== false;
        const rightObserved = right?.observed !== false;
        if (leftObserved !== rightObserved) {
            differences.push({ path: `$.${name}.observed`, reference: leftObserved, candidate: rightObserved, reason: 'observer availability differs' });
            continue;
        }
        if (!leftObserved) {
            skipped.push(name);
            continue;
        }
        collectDifferences(left, right, `$.${name}`, differences);
        compared.push(name);
    }

    return { matches: differences.length === 0, compared, skipped, differences };
}

function collectDifferences(reference, candidate, location, differences) {
    if (Object.is(reference, candidate)) return;
    if (Array.isArray(reference) || Array.isArray(candidate)) {
        if (!Array.isArray(reference) || !Array.isArray(candidate)) {
            differences.push({ path: location, reference, candidate, reason: 'value types differ' });
            return;
        }
        if (reference.length !== candidate.length) {
            differences.push({ path: `${location}.length`, reference: reference.length, candidate: candidate.length, reason: 'array lengths differ' });
        }
        const length = Math.min(reference.length, candidate.length);
        for (let index = 0; index < length; index++) collectDifferences(reference[index], candidate[index], `${location}[${index}]`, differences);
        return;
    }
    if (isRecord(reference) || isRecord(candidate)) {
        if (!isRecord(reference) || !isRecord(candidate)) {
            differences.push({ path: location, reference, candidate, reason: 'value types differ' });
            return;
        }
        const keys = [...new Set([...Object.keys(reference), ...Object.keys(candidate)])].sort();
        for (const key of keys) {
            if (!(key in reference) || !(key in candidate)) {
                differences.push({ path: `${location}.${key}`, reference: reference[key], candidate: candidate[key], reason: 'field presence differs' });
                continue;
            }
            collectDifferences(reference[key], candidate[key], `${location}.${key}`, differences);
        }
        return;
    }
    differences.push({ path: location, reference, candidate, reason: 'values differ' });
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [referencePath, candidatePath] = process.argv.slice(2);
    if (!referencePath || !candidatePath) {
        console.error('usage: node tools/compare-observations.mjs <node-capture.json> <gotavern-capture.json>');
        process.exit(2);
    }
    const result = compareObservations(
        JSON.parse(readFileSync(referencePath, 'utf8')),
        JSON.parse(readFileSync(candidatePath, 'utf8')),
    );
    for (const name of result.compared) console.log(`compared ${name}`);
    for (const name of result.skipped) console.log(`skipped ${name}: both captures mark it unobserved`);
    for (const difference of result.differences.slice(0, 50)) {
        console.error(`${difference.path}: ${difference.reason}`);
        console.error(`  Node: ${JSON.stringify(difference.reference)}`);
        console.error(`  Go:   ${JSON.stringify(difference.candidate)}`);
    }
    if (!result.matches) process.exit(1);
    console.log('all observed surfaces match');
}
