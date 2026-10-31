// Pure release-notes validation. The publication step calls this before `gh release create`, so a curated body that
// still carries a draft placeholder (a TODO, an angle-bracket token, an example checksum, a truncated fake run id)
// cannot become a published release's permanent text.
//
// WHY THIS IS A PROGRAM AND NOT A GREP IN THE WORKFLOW. Alpha.9's publish path grepped for one placeholder shape
// (`<UPPER:`) inside a shell `if`; that catches exactly one drafting convention and runs only on the stable path, and
// the rule lived nowhere a test could execute it. The rules below are data a test table drives, and the workflow runs
// the same program for BOTH channels, because a prerelease's body is just as permanent.
//
// The rules are deliberately about SHAPES, never about content: a release note is allowed to say anything factually
// wrong, and no program can fix that. What a program can refuse is a body that was never finished.

export const MIN_BODY_BYTES = 1500;

// Words that mean "this sentence is a note to the author". Whole words, case-insensitive, so `TODOS` is not a hit and
// a product name is not a false positive by accident.
const FORBIDDEN_WORDS = ['TODO', 'TBD', 'FIXME', 'PLACEHOLDER', 'XXX'];

// Angle-bracket tokens a draft leaves behind. Listed explicitly rather than as a generic `<word>` regex: release notes
// are Markdown and legitimately contain HTML-ish text, and a broad rule would train the author to work around the
// checker instead of finishing the note.
const PLACEHOLDER_TOKENS = [
    '<version>', '<VERSION>', '<date>', '<DATE>', '<sha>', '<SHA>', '<commit>', '<COMMIT>', '<tag>', '<TAG>',
    '<run id>', '<run-id>', '<run_id>', '<checksum>', '<CHECKSUM>', '<asset>', '<url>', '<URL>',
];

const REQUIRED_SECTIONS = [
    { label: 'a level-1 title', test: (text) => /^#\s+\S/m.test(text) },
    { label: 'a "Known limitations" section', test: (text) => /^##\s+Known limitations\s*$/mi.test(text) },
    { label: 'a "Checksums" or "Artifacts" section', test: (text) => /^##\s+(Checksums?|Artifacts?)\s*$/mi.test(text) },
];

function countBytes(text) {
    return Buffer.byteLength(text, 'utf8');
}

// Runs of 64 lowercase hex characters. A real release note cites real digests; an example checksum is either a run of
// one repeated character or a value that does not appear in the release's own checksums.txt. Both are refused when the
// caller supplies the checksums file (the release workflow always does).
function findHexDigests(text) {
    return [...text.matchAll(/\b[0-9a-f]{64}\b/g)].map((match) => match[0]);
}

function isDegenerateDigest(digest) {
    const distinct = new Set(digest).size;
    return distinct <= 4 || /^0+$/.test(digest) || /^f+$/.test(digest);
}

function checksumEntries(checksumsText) {
    const entries = new Map();
    for (const line of checksumsText.split(/\r?\n/)) {
        const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
        if (match) entries.set(match[2].trim(), match[1]);
    }
    return entries;
}

/**
 * @param {{ text: string, tag: string, checksumsText?: string|null }} input
 * @returns {{ ok: boolean, problems: string[], observations: string[] }}
 */
export function validateReleaseNotes({ text, tag, checksumsText = null }) {
    const problems = [];
    const observations = [];
    if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, problems: ['release notes body is empty'], observations };
    }
    if (typeof tag !== 'string' || tag.trim() === '') {
        return { ok: false, problems: ['a tag argument is required (the note must name the release it describes)'], observations };
    }
    const bytes = countBytes(text);
    if (bytes < MIN_BODY_BYTES) {
        problems.push(`release notes body is ${bytes} bytes; a curated release body below ${MIN_BODY_BYTES} bytes is a stub, not a note (the task is to describe the release, not to clear the check)`);
    }
    // THE TAG MUST MATCH AS A VERSION TOKEN, NOT AS A SUBSTRING. `v0.1.0-beta.1`.includes(`v0.1.0`) is true, so a
    // naive includes() accepts a note written for the beta when it is published as the plain release (and every other
    // prefix relationship). The boundaries are "not a version-ish character", so the tag inside a URL or a sentence
    // still counts while a longer version string does not.
    const tagPattern = new RegExp(`(^|[^0-9A-Za-z.+-])${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9A-Za-z.+-]|$)`);
    if (!tagPattern.test(text)) {
        problems.push(`release notes do not name the tag ${JSON.stringify(tag)} as a version token; a body that never names its own release can be published against the wrong tag`);
    }

    for (const word of FORBIDDEN_WORDS) {
        const re = new RegExp(`\\b${word}\\b`, 'gi');
        const hits = [...text.matchAll(re)];
        if (hits.length > 0) problems.push(`release notes still contain the drafting word ${word} (${hits.length} occurrence(s))`);
    }
    for (const token of PLACEHOLDER_TOKENS) {
        if (text.includes(token)) problems.push(`release notes still contain the unfilled placeholder ${token}`);
    }

    // A cited run id is a number after "run"/"runs". Real Actions run ids are 9-12 digits; a 1-7 digit value is a
    // hand-written stand-in. This is the rule alpha.9's checklist had to enforce by reading the note.
    for (const match of text.matchAll(/\bruns?\s+`?(\d{1,7})\b/gi)) {
        problems.push(`release notes cite a too-short run id ${JSON.stringify(match[1])} after "${match[0].trim()}"; real run ids are at least 8 digits`);
    }

    if (checksumsText !== null) {
        const entries = checksumEntries(checksumsText);
        if (entries.size === 0) {
            problems.push('checksums.txt supplied to the notes validator contains no sha256sum entries; the digest check would be vacuous');
        }
        const known = new Set(entries.values());
        const cited = findHexDigests(text);
        for (const digest of cited) {
            if (isDegenerateDigest(digest)) {
                problems.push(`release notes cite a degenerate 64-hex value ${digest.slice(0, 16)}... which is an example checksum, not a digest`);
            } else if (!known.has(digest)) {
                problems.push(`release notes cite 64-hex ${digest.slice(0, 16)}... which matches no asset in checksums.txt`);
            }
        }
        observations.push(`${cited.length} cited digest(s) checked against ${entries.size} asset(s)`);

        // A canonical asset named beside a digest on the same line must match that asset's real digest. The digest
        // scan above already covers membership; this names WHICH asset is misquoted, which is the diagnosis an author
        // needs when the note cites the right digest next to the wrong file.
        for (const line of text.split(/\r?\n/)) {
            const asset = line.match(/\bgotavern-[a-z0-9-]+\.(?:tar\.gz|zip)\b/);
            if (!asset) continue;
            const digests = findHexDigests(line);
            if (digests.length === 0) continue;
            const expected = entries.get(asset[0]);
            if (expected === undefined) {
                problems.push(`release notes name asset ${asset[0]} which is not in checksums.txt`);
            } else if (!digests.includes(expected)) {
                problems.push(`release notes name asset ${asset[0]} with a digest that is not its checksum (expected ${expected.slice(0, 16)}...)`);
            }
        }
    } else {
        observations.push('no checksums.txt supplied: digest membership was not checked');
    }

    for (const section of REQUIRED_SECTIONS) {
        if (!section.test(text)) problems.push(`release notes are missing ${section.label}`);
    }

    return { ok: problems.length === 0, problems, observations };
}

export { FORBIDDEN_WORDS, PLACEHOLDER_TOKENS, REQUIRED_SECTIONS, countBytes };
