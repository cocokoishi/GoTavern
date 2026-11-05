// THE EMBEDDED EVIDENCE CONTRACT: a required artifact is not proof until its CONTENT says what it is.
//
// A green run with the right artifact name is still only a claim about a name: the aggregator step that was supposed
// to write the evidence can be skipped while the workflow concludes success, an artifact can be uploaded from an
// earlier attempt, or a small-tier run can upload an artifact whose name looks like the medium one. The release
// manifest therefore names a fixed artifact AND describes the release-evidence document inside it
// (`requiredEvidence`); this module owns BOTH halves of that contract:
//
//   * the ZIP reader that pulls the evidence member out of the artifact archive GitHub serves, and
//   * the validator that checks schemaVersion / kind / the EMBEDDED HEAD SHA / the tier marker / required truthy
//     fields / required 64-hex digests.
//
// KEPT SEPARATE FROM gates.mjs because the zip parsing is byte-level and the decision logic is pure: the test suite
// can exercise a fabricated stored-zip with no network, and can include honest corrupt-archive cases, without making
// the pure gate depend on a buffer format.

import { inflateRawSync } from 'node:zlib';

// The canonical member name. Every workflow that produces release evidence writes this file at the ARTIFACT ROOT,
// so the verifier looks for exactly one well-known member instead of globbing arbitrary paths inside the archive.
export const EVIDENCE_MEMBER = 'release-evidence.json';
export const EVIDENCE_SCHEMA_VERSION = 1;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
    // The EOCD is the last record; its comment is limited to 65535 bytes, so scan backwards over that window.
    const minimum = Math.max(0, buffer.length - 65535 - 22);
    for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
        if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
    }
    return -1;
}

function readCentralDirectoryEntries(buffer) {
    const eocd = findEndOfCentralDirectory(buffer);
    if (eocd < 0) return null;
    const entryCount = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    const entries = [];
    for (let index = 0; index < entryCount; index += 1) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return null;
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        if (offset + 46 + nameLength > buffer.length) return null;
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

// Extract one member from a ZIP archive as UTF-8 text. Returns null when the archive is not a readable zip or the
// member is absent; both are REFUSALS (the caller fails closed), never empty strings that could read as evidence.
export function extractZipMember(buffer, memberName) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null;
    const entries = readCentralDirectoryEntries(buffer);
    if (entries === null) return null;
    const entry = entries.find((candidate) => candidate.name === memberName && !candidate.name.endsWith('/'));
    if (!entry) return null;
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) return null;
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) return null;
    const raw = buffer.subarray(dataStart, dataEnd);
    try {
        if (entry.method === 0) return raw.toString('utf8');
        if (entry.method === 8) return inflateRawSync(raw).toString('utf8');
    } catch {
        return null;
    }
    return null;
}

// Parse the release-evidence member out of an artifact archive. The result always has either `evidence` (a parsed
// object) or `error` (a named reason); a caller must treat `error` as a refusal, never as "no marker to check".
export function parseReleaseEvidence(buffer, memberName = EVIDENCE_MEMBER) {
    const text = extractZipMember(buffer, memberName);
    if (text === null) {
        return { evidence: null, error: `the artifact archive has no readable ${memberName} member` };
    }
    try {
        const evidence = JSON.parse(text);
        if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
            return { evidence: null, error: `${memberName} is not a JSON object` };
        }
        return { evidence, error: null };
    } catch (error) {
        return { evidence: null, error: `${memberName} is not valid JSON: ${error.message}` };
    }
}

function memberAt(value, dottedPath) {
    let current = value;
    for (const key of String(dottedPath).split('.')) {
        if (current === null || current === undefined || typeof current !== 'object') return undefined;
        current = current[key];
    }
    return current;
}

// Validate one artifact's evidence against the manifest spec. `sha` is the candidate commit the run must judge, so
// the embedded-head-SHA check is the same-SHA property applied to the CONTENT (a run can be at the right SHA while
// carrying an artifact recorded from another one; the marker is what makes that visible).
export function validateReleaseEvidence({ evidence, spec, sha, artifactName }) {
    const problems = [];
    if (!evidence) {
        problems.push(`the artifact ${JSON.stringify(artifactName)} carries no release-evidence document`);
        return problems;
    }
    if (typeof spec?.kind !== 'string' || spec.kind === '') {
        problems.push('the manifest requiredEvidence.kind is missing, so the artifact content cannot be judged');
        return problems;
    }
    if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
        problems.push(`evidence schemaVersion is ${JSON.stringify(evidence.schemaVersion)}, expected ${EVIDENCE_SCHEMA_VERSION}`);
    }
    if (evidence.kind !== spec.kind) {
        problems.push(`evidence kind is ${JSON.stringify(evidence.kind)}, expected ${JSON.stringify(spec.kind)}`);
    }
    if (evidence.headSha !== sha) {
        problems.push(`evidence headSha is ${JSON.stringify(evidence.headSha)}, not the candidate ${sha}`);
    }
    if (spec.tier !== undefined) {
        const tierField = spec.tierField ?? 'tier';
        if (typeof tierField !== 'string' || tierField === '') {
            problems.push('the manifest requiredEvidence.tierField is not a non-empty member path');
        } else if (memberAt(evidence, tierField) !== spec.tier) {
            problems.push(`evidence ${tierField} is ${JSON.stringify(memberAt(evidence, tierField))}, expected the required tier ${JSON.stringify(spec.tier)}`);
        }
    }
    for (const path of spec.requireTruthy ?? []) {
        if (memberAt(evidence, path) !== true) {
            problems.push(`evidence ${path} is ${JSON.stringify(memberAt(evidence, path))}, expected exactly true`);
        }
    }
    for (const path of spec.requireSha256 ?? []) {
        const value = memberAt(evidence, path);
        if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
            problems.push(`evidence ${path} is ${JSON.stringify(value)}, expected a lowercase 64-hex SHA-256 digest`);
        }
    }
    return problems;
}
