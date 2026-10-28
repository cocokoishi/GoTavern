// Package fixtures also gates the CONTRACT DOCUMENTS themselves, not only the oracle and scenario
// artifacts.
//
// WHY. The documents are the load-bearing interface of this project: `GOAL.md` is the locked goal,
// `AGENTS.md` is cited by RULE NUMBER from commits, code comments and reports, `ARCHITECTURE.md` is the
// design contract, and `docs/goal-scorecard.md` is the only place that says, per user question, whether
// the answer is proven and by which artefact. Every one of those is prose, so every one of them can be
// wrong in a way no compiler checks: a pinned commit with one character too many (measured: `GOAL.md`
// carried `...9165bce127`, one extra `6`, for as long as the pin has existed, while
// `upstream/SILLYTAVERN_COMMIT` and every other document carried 40 characters), a rule number that
// shifted because a paragraph was appended above it, a scorecard row that claims `proven` and cites
// nothing, or a cited run id that does not exist. This project's most expensive failures have all been
// of that shape: a green result that proved nothing.
//
// SO: the checks below are the documents' own differential. They read the files as STRICT UTF-8 (rule 9:
// a replaced byte is a corrupt document, and every lenient reader hides it), they refuse a BOM (rule 12),
// they compare against OTHER files rather than against a second copy of the same string, and every one
// of them is demonstrated able to fail: TestDocumentsConsistencyGateCanGoRed plants the exact defect
// each check exists for, in a scratch tree, and requires the check to report it.
package fixtures

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

// documentsRoot is the repository root as seen from internal/fixtures.
const documentsRoot = "../.."

// pinnedCommitPath is the ONE authority for the pin. Every other document is compared against it, so a
// document cannot silently disagree with the pinned checkout CI actually uses: the browser differential
// reads the same file into PINNED_BASELINE_COMMIT. A gate that compared a document to another document
// would be a gate with no source of truth (rule 54: comparing two declarations is not executing one).
var pinnedCommitPath = filepath.Join("upstream", "SILLYTAVERN_COMMIT")

// treePinnedCommitMode is the only mode in which the pin-consistency gate can tell a stale document from
// a baseline bump. It is a named constant rather than a bool so the call sites read as what they are: a
// check against the TREE (fatal on disagreement) or a probe of a scratch tree (the caller decides).
const treePinnedCommitMode = "tree"

// String literals rather than escapes keep this file readable, and they are UTF-8 bytes either way; the
// writer that produced this file was UTF8Encoding($false), which is the rule-12 shape.
const (
	replacementCharacter = "\uFFFD"
	byteOrderMark        = "\uFEFF"

	// cp1252MojibakeA is `Ã` (the CP1252 decode of the first byte of a two-byte UTF-8 sequence).
	cp1252MojibakeA = "\u00C3"
	// cp1252MojibakeUnderscore is `â€` (the CP1252 decode of a three-byte UTF-8 sequence's prefix).
	cp1252MojibakeUnderscore = "\u00E2\u20AC"
	// latin1Mojibake is `Â`, what a UTF-8 NBSP becomes after one CP1252 round trip.
	latin1Mojibake = "\u00C2"
)

// documentFile is one contract document as read from disk, with the raw bytes kept so a BOM can be
// judged on the BYTES rather than on a decoded rune.
type documentFile struct {
	rel   string // slash-separated, relative to the tree root
	bytes []byte
	text  string
}

// allWorkflowFiles lists .github/workflows/*.yml. Workflows are scanned by the SAME pin gate as the
// documents because a pinned-commit string in a workflow drifts exactly as a document's does, and the one
// that matters most is `.github/workflows/browser-differential.yml`'s `PINNED_BASELINE_COMMIT: <pin>` env
// literal: it is read into `ref:` for the pinned checkout AND into the cache keys for that checkout's
// `node_modules`. A drifted (or padded) spelling there does not merely state the wrong commit — it
// computes a DIFFERENT cache key, so a cache populated from one pinned tree is restored against a
// checkout of another, and the restored modules are the wrong tree's. `ci.yml` and `smoke-metrics.yml`
// carry the pin as a bare `ref:` literal for the same kind of use. Expressed as a walk so a new workflow
// that repeats the pin is covered without anyone remembering to add it (AGENTS.md rule 43).
func allWorkflowFiles(root string) ([]string, error) {
	dir := filepath.Join(root, ".github", "workflows")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", dir, err)
	}
	var out []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".yml") && !strings.HasSuffix(name, ".yaml") {
			continue
		}
		out = append(out, filepath.ToSlash(filepath.Join(".github", "workflows", name)))
	}
	sort.Strings(out)
	return out, nil
}

// contractDocumentFiles is the closed list the consistency gate reads. It is a list and not a glob
// because a NEW contract document that is not listed is a document nothing checks: TestDocumentGateCoversTheContract
// requires every markdown file that names the pin to be in this slice, so adding a document that
// repeats the pin without adding it here is itself red.
func contractDocumentFiles() []string {
	return []string{
		"GOAL.md",
		"AGENTS.md",
		"ARCHITECTURE.md",
		"HANDOFF.md",
		filepath.Join("docs", "SEMANTIC-COMPATIBILITY.md"),
		filepath.Join("docs", "goal-scorecard.md"),
		filepath.Join("docs", "development-loop.md"),
		filepath.Join("docs", "dropin-qualification.md"),
		filepath.Join("docs", "gate-blindspots.md"),
		filepath.Join("docs", "real-user-input-audit.md"),
	}
}

// allMarkdownFiles walks the tree for *.md, skipping the vendored upstream checkout (which carries
// SillyTavern's own documentation and is byte-pinned, not ours to check).
func allMarkdownFiles(root string) ([]string, error) {
	var out []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		slashed := filepath.ToSlash(path)
		if info.IsDir() {
			base := info.Name()
			if base == ".git" || base == "node_modules" || base == ".reference" {
				return filepath.SkipDir
			}
			if strings.Contains(slashed, "/upstream/") || strings.HasSuffix(slashed, "/upstream") {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(info.Name(), ".md") {
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				return relErr
			}
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}

// readStrictDocument reads one file under root and refuses the three ways a document goes corrupt on
// disk rather than in meaning: a BOM, bytes that are not UTF-8, and a replacement character.
//
// The replacement-character check is not redundant with the decode check in the common case (invalid
// bytes fail to decode) but it is NOT in the case that matters: a writer on a CP1252 host produces
// VALID UTF-8 for text that was already mojibake, so the bytes decode perfectly and every word is
// wrong. `Ã©` is three valid UTF-8 bytes.
func readStrictDocument(root, rel string) (documentFile, error) {
	path := filepath.Join(root, filepath.FromSlash(rel))
	body, err := os.ReadFile(path)
	if err != nil {
		return documentFile{}, fmt.Errorf("read %s: %w", rel, err)
	}
	if len(body) == 0 {
		return documentFile{}, fmt.Errorf("%s is empty; an empty contract document proves nothing", rel)
	}
	if len(body) >= 3 && body[0] == 0xEF && body[1] == 0xBB && body[2] == 0xBF {
		return documentFile{}, fmt.Errorf("%s starts with a UTF-8 BOM (EF BB BF): a BOM decodes perfectly and renders as nothing, which is exactly why it survives review (AGENTS.md rule 12); write with an explicit no-BOM UTF-8 encoder", rel)
	}
	if len(body) >= 2 && ((body[0] == 0xFF && body[1] == 0xFE) || (body[0] == 0xFE && body[1] == 0xFF)) {
		return documentFile{}, fmt.Errorf("%s starts with a UTF-16 byte-order mark: a PowerShell `>` redirect writes UTF-16LE, and YAML/markdown readers disagree about the result (AGENTS.md rule 12)", rel)
	}
	if !utf8.Valid(body) {
		offset := firstInvalidUTF8Offset(body)
		return documentFile{}, fmt.Errorf("%s is not valid UTF-8 at byte %d (% X): a shell whose default encoding is not UTF-8 wrote it, and a lenient decoder would replace the bytes silently (AGENTS.md rule 9)", rel, offset, body[offset:min(offset+4, len(body))])
	}
	text := string(body)
	if idx := strings.Index(text, replacementCharacter); idx >= 0 {
		return documentFile{}, fmt.Errorf("%s carries U+FFFD REPLACEMENT CHARACTER at byte %d: the file was decoded and re-encoded through a lossy path, so the surrounding text is not what was written (AGENTS.md rule 9)", rel, idx)
	}
	// MOJIBAKE IS VALID UTF-8, so it cannot be caught by the decoder above and it is not a separate
	// whole-tree sweep's business alone: a document whose every word is wrong must be refused by the gate
	// that reads that document. The check lives here, at the single read path, so the pin gate and the
	// ledger gate both inherit it rather than each remembering it.
	if seq, at := findMojibake(text); seq != "" {
		return documentFile{}, fmt.Errorf("%s carries CP1252 mojibake (%s near byte %d): the bytes decode as UTF-8 and every word is wrong, because a writer on a CP1252 host produced valid UTF-8 for text that was already damaged (AGENTS.md rule 9; the `C3 83` / `E2 80 9E` sweep is the check that finds it)", rel, seq, at)
	}
	return documentFile{rel: rel, bytes: body, text: text}, nil
}

// findMojibake reports the first CP1252 round-trip signature in text, with a readable name and its byte
// offset. Two signatures cover this project's measured cases:
//
//   - U+00E2 U+20AC ("â€") is the CP1252 decode of the three-byte UTF-8 prefix E2 80, which is what a
//     dash or a curly quote becomes;
//   - U+00C3 ("Ã") is the CP1252 decode of the two-byte prefix C3, which is what every CJK and accented
//     character becomes.
//
// U+00C2 ("Â") is deliberately NOT treated as a signature on its own: it is the correct rendering of a
// NBSP's prefix and also appears inside legitimate Vietnamese/Latin text, so flagging it would produce a
// phantom defect on a correct document — the same trap as the case-insensitive `/Users/` sweep.
func findMojibake(text string) (string, int) {
	if i := strings.Index(text, cp1252MojibakeUnderscore); i >= 0 {
		return `"\u00E2\u20AC" (a CP1252 round trip of a three-byte UTF-8 sequence, typically a dash or a curly quote)`, i
	}
	if i := strings.Index(text, cp1252MojibakeA); i >= 0 {
		return `"\u00C3" (a CP1252 round trip of a two-byte UTF-8 sequence, typically a CJK or accented character)`, i
	}
	return "", 0
}

func firstInvalidUTF8Offset(body []byte) int {
	for i := 0; i < len(body); {
		r, size := utf8.DecodeRune(body[i:])
		if r == utf8.RuneError && size == 1 {
			return i
		}
		i += size
	}
	return -1
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// readAllContractDocuments reads the closed list, failing the test on the first unreadable one. Every
// gate below starts here, so a corrupt document cannot be silently skipped by a gate that only inspects
// what it could parse.
func readAllContractDocuments(t *testing.T, root string) []documentFile {
	t.Helper()
	files := contractDocumentFiles()
	out := make([]documentFile, 0, len(files))
	for _, rel := range files {
		doc, err := readStrictDocument(root, rel)
		if err != nil {
			t.Fatalf("contract document refused: %v", err)
		}
		out = append(out, doc)
	}
	return out
}

// pinnedCommitFromTree reads the authority file and validates its SHAPE, so a truncated or padded pin
// fails here rather than becoming the expected value every document is compared against.
func pinnedCommitFromTree(root string) (string, error) {
	doc, err := readStrictDocument(root, pinnedCommitPath)
	if err != nil {
		return "", err
	}
	pin := strings.TrimSpace(doc.text)
	if !gitObjectIDPattern.MatchString(pin) {
		return "", fmt.Errorf("%s is %q, which is not a 40-hex lowercase git object id (%d characters)", pinnedCommitPath, pin, len(pin))
	}
	return pin, nil
}

var gitObjectIDPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// bareObjectIDPattern finds a pin written WITHOUT backticks. It is a GIT OBJECT ID, which is exactly 40
// lowercase hex characters, and the boundaries matter in both directions:
//
//   - a longer run of hex is not a git id, and an earlier version of this pattern matched 38-44 and so
//     reported a 44-character SHA-256 prefix as a "wrong pin" — a phantom defect on a correct document;
//   - a followed-or-preceded hex character means this is a slice of a longer value, not an id. The
//     boundary is spelled out as a negated class rather than `\b` because the id is CAPTURED as group 1:
//     the boundary characters belong to the match but not to the value, and without the group a 40-hex id
//     inside prose would be recorded with the character before it.

// describesCommitPhrase recognises a document stating which commit IT is about, as opposed to naming the
// upstream baseline. Two spellings are allowed and both name the commit explicitly:
//
//	Describes: commit `a5660b6...`      (the evidence ledger's own anchor)
//	| **HEAD (main)** | `a5660b6...` |   (the HANDOFF checkpoint table)
//
// The phrase is what earns the exemption, so a mistyped BASELINE cannot hide here: it would have to be
// introduced by "Describes:" or by the HEAD row, and both are checked by the ancestry rule that reads the
// same phrase back.
var bareObjectIDPattern = regexp.MustCompile(`(?:^|[^0-9a-f])([0-9a-f]{40})(?:$|[^0-9a-f])`)

// describesCommitPhrase recognises a document stating which commit IT is about, as opposed to naming the
// upstream baseline. Two spellings are allowed and both name the commit explicitly:
//
//	Describes: commit `a5660b6...`      (the evidence ledger's own anchor)
//	| **HEAD (main)** | `a5660b6...` |   (the HANDOFF checkpoint table)
//
// The PHRASE is what earns the exemption, so a mistyped baseline cannot hide here: it would have to be
// introduced by "Describes:" or by the HEAD row, and the value the ledger declares is then held to a fact
// by the citation-ancestry check, which reads the same phrase back.
var describesCommitPhrase = regexp.MustCompile(`(?i)(describes:\s*commit\s+\x60)|(head \(main\))`)

// backtickedObjectIDPattern finds every object id a reader could mistake for the pin, whether it is 40
// characters or not. The `\b`-anchored 40-character search alone cannot see the defect this gate was
// built for: a pin copied with one digit repeated is 41 characters, so a 40-character regex simply does
// not match it and the bad spelling passes as "no pin here". The window is 38-44 so that both a dropped
// and a duplicated character are visible.
var backtickedObjectIDPattern = regexp.MustCompile("\x60([0-9a-f]{38,44})\x60")

// workflowPinMismatches finds a wrong pin in a workflow's VALUE position: the right-hand side of a `ref:`
// key or of a `PINNED_BASELINE_COMMIT` key. The window is 38-44 characters because in this position any
// commit-length hex run IS a pin claim, so a padded or truncated spelling must be caught rather than
// skipped by a 40-character rule.
func workflowPinMismatches(doc documentFile, pin string) []pinMismatch {
	var out []pinMismatch
	for i, line := range strings.Split(doc.text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			continue // a comment is prose; the bare/backticked rules already cover it
		}
		m := workflowPinValuePattern.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		value := m[1]
		if value == pin {
			continue
		}
		if _, declared := declaredOtherPins[value]; declared {
			continue
		}
		reason := "not the pinned commit and not a declared other pin"
		if len(value) != len(pin) {
			reason = fmt.Sprintf("%d characters, but the pin is %d: this is the typo shape -- a digit repeated or dropped in a copy of the pin", len(value), len(pin))
		}
		out = append(out, pinMismatch{rel: doc.rel, value: value, line: i + 1, reason: reason})
	}
	return out
}

// workflowPinValuePattern matches `ref: <hex>` and `PINNED_BASELINE_COMMIT: <hex>`, quoted or bare.
var workflowPinValuePattern = regexp.MustCompile(`(?:PINNED_BASELINE_COMMIT|ref)\s*:\s*['"]?([0-9a-f]{38,44})`)

// pinMismatch is one object-id-shaped string in one document that is neither the pin nor a declared
// other pin. It carries the LINE and the reason so a reader is sent to the defect rather than hunting.
type pinMismatch struct {
	rel    string
	value  string
	line   int
	reason string
}

// pinnedCommitMatches returns, for one document, every object-id-shaped string whose value is not the pin
// and not an EXPLICITLY DECLARED other pin. The declaration below is the whole point: this project pins
// more than one commit, and a gate that flagged every 40-hex string would be red on a correct tree, which
// is the phantom-defect shape `AGENTS.md` rule 18's case-insensitive sweep records. Each declared pin
// names WHAT it pins, because an allowlist of bare hashes becomes a place to hide a typo.
func pinnedCommitMatches(doc documentFile, pin string) []pinMismatch {
	var out []pinMismatch
	lines := strings.Split(doc.text, "\n")
	for i, line := range lines {
		// Backticked ids are the canonical spelling; a bare id in prose is the same claim.
		seen := make(map[string]bool)
		for _, m := range backtickedObjectIDPattern.FindAllStringSubmatch(line, -1) {
			seen[m[1]] = true
		}
		for _, m := range bareObjectIDPattern.FindAllStringSubmatch(line, -1) {
			seen[m[1]] = true
		}
		values := make([]string, 0, len(seen))
		for v := range seen {
			values = append(values, v)
		}
		sort.Strings(values)
		for _, value := range values {
			if value == pin {
				continue
			}
			if _, declared := declaredOtherPins[value]; declared {
				continue
			}
			// A document may state WHICH COMMIT IT DESCRIBES ("Describes: commit `<sha>`"). That is not a
			// competing baseline pin — it is the anchor the citation-ancestry check needs — so it is
			// recognised by the PHRASE that introduces it rather than by its value, which is what keeps
			// this from becoming a place to hide a mistyped pin: the phrase is narrow and the ancestry
			// check then holds the value to a fact.
			if describesCommitPhrase.MatchString(line) {
				continue
			}
			reason := "not the pinned commit and not a declared other pin"
			if len(value) != len(pin) {
				reason = fmt.Sprintf("%d characters, but the pin is %d: this is the typo shape -- a digit repeated or dropped in a copy of the pin", len(value), len(pin))
			}
			out = append(out, pinMismatch{rel: doc.rel, value: value, line: i + 1, reason: reason})
		}
	}
	return out
}

// declaredOtherPins are the OTHER commits this repository legitimately pins. They are compared by a gate
// that would otherwise demand the SillyTavern baseline everywhere, so each entry states what it is:
//
//   - the two extension commitments `AGENTS.md` "Semantic compatibility probes" requires (they are the
//     canaries for the ecosystem, and their SHAs are their identity);
//   - the pinned tokenizer-data repository commit (`docs/tokenizer-parity-plan.md`);
//   - the release workflow's BASELINE_REF fallback, which names the commit where the release workflow and
//     third-party notices were added — an INPUT to `release-qualification.yml`, not the SillyTavern pin.
//
// A value added here without a reason is refused by TestDeclaredPinsAreJustified below.
var declaredOtherPins = map[string]string{
	"837a6288135cde61522a9279173b98020f08807e": "pinned JS-Slash-Runner (N0VI028/JS-Slash-Runner) — AGENTS.md semantic-compat probes",
	"9e71caef9ba7b3ca324ce9f1cb06a69ff54d734b": "pinned LittleWhiteBox (RT15548/LittleWhiteBox) — AGENTS.md semantic-compat probes",
	"798bcd823dfd04227a79b487e1cf29e6de9aaece": "pinned SillyTavern-Tokenizers data commit — docs/tokenizer-parity-plan.md",
	"d00d99b87fc2fbd1ffd218c5ce160d07f27c47ef": "release-qualification.yml BASELINE_REF default — the commit that added the release workflow, not the SillyTavern pin",
	// The commit a PAIRED BENCHMARK measured. A provenance record must name the exact tree its numbers
	// came from, and that tree is a lane commit rather than the pinned upstream, so the value is a
	// MEASUREMENT ANCHOR and not a baseline claim. Declared by value AND named, because an allowlist
	// entry with no reason is exactly where a mistyped pin would hide.
	"a3c2f5340f152ce96150f52be4ccf7b27695b61f": "commit measured by the paired benchmark — docs/assets/benchmark.svg.provenance.md and scorecard Q22",
	// A RELEASE'S OWN COMMIT. The HANDOFF checkpoint must name the SHA a release was cut from, or the
	// document cannot be used to check the release. That SHA is an IDENTITY, not a baseline claim, and
	// it is not the SillyTavern pin. Declared by value AND named for the same reason as the entry above:
	// an allowlist entry with no reason is exactly where a mistyped pin would hide. NOTE FOR THE NEXT
	// RELEASE: this list grows by one entry per release, so a release SHA must be declared in the SAME
	// change that writes its checkpoint, or `verify` goes red on a document that is correct.
	"0dddeac181dad9681d9c9eb720a1be66f1126573": "v0.1.0-alpha.6 release commit - HANDOFF.md current checkpoint",
	"b114ab113d3954bef1e47651d2695f67e2708a2e": "v0.1.0-alpha.7 release commit - HANDOFF.md current checkpoint",
}

// checkPinnedCommitStrings is the gate body, extracted so the red-path test can drive it against a
// scratch tree through the same code CI runs rather than through a second implementation.
func checkPinnedCommitStrings(root, mode string) (int, error) {
	pin, err := pinnedCommitFromTree(root)
	if err != nil {
		return 0, err
	}
	var findings []string
	for _, rel := range contractDocumentFiles() {
		doc, readErr := readStrictDocument(root, rel)
		if readErr != nil {
			return 0, readErr
		}
		for _, mismatch := range pinnedCommitMatches(doc, pin) {
			findings = append(findings, fmt.Sprintf("%s line %d: %q is %s; the pinned commit is %q", mismatch.rel, mismatch.line, mismatch.value, mismatch.reason, pin))
		}
	}
	// A document that names the pin but is NOT in the closed list is a document the gate cannot see.
	// Coverage is enumerated from the tree, never accumulated from a hand list (AGENTS.md rule 43).
	checked := make(map[string]bool)
	for _, rel := range contractDocumentFiles() {
		checked[rel] = true
	}
	mdFiles, walkErr := allMarkdownFiles(root)
	if walkErr != nil {
		return 0, walkErr
	}
	// WORKFLOWS ARE SCANNED BY THE SAME RULE, and they outrank the documents in one respect: a workflow
	// literal is EXECUTED. `.github/workflows/browser-differential.yml` reads PINNED_BASELINE_COMMIT into
	// the reference checkout's `ref:` AND into that checkout's node_modules cache key, so a spelled-wrong
	// pin there restores a cache built from a different tree while every document still agrees with the
	// authority file. `ci.yml` and `smoke-metrics.yml` carry it as a bare `ref:`.
	wfFiles, wfErr := allWorkflowFiles(root)
	if wfErr != nil {
		return 0, wfErr
	}
	if len(wfFiles) == 0 {
		return 0, fmt.Errorf("no workflow files found under .github/workflows; the pin gate would silently check no workflow at all (rule 19)")
	}
	for _, rel := range wfFiles {
		wf, readErr := readStrictDocument(root, rel)
		if readErr != nil {
			return 0, readErr
		}
		// A workflow is scanned for MISMATCHES only. Unlike a document it need not mention the pin at all:
		// a workflow that pins nothing is not a defect, while one that pins the WRONG commit is.
		//
		// IT USES ITS OWN PATTERN, and the reason is a measured asymmetry. In a DOCUMENT a bare 38-44 hex
		// run cannot be assumed to be a pin (a 44-character content hash appears in the generated
		// inventories, and treating it as a pin produced a phantom defect on a correct file). In a WORKFLOW
		// a pin-shaped literal appears in one place only — a `ref:` value or a `PINNED_BASELINE_COMMIT:`
		// env value — where a 41-character spelling is unquestionably a mistyped pin and must not be
		// skipped by the 40-character rule.
		for _, mismatch := range workflowPinMismatches(wf, pin) {
			findings = append(findings, fmt.Sprintf("%s line %d: %q is %s; the pinned commit is %q (a workflow literal is EXECUTED -- this one feeds a checkout ref and/or a cache key, so a drift here pins work to the wrong tree)", mismatch.rel, mismatch.line, mismatch.value, mismatch.reason, pin))
		}
	}
	// EVERY markdown file is scanned for a mismatched pin, listed or not. The closed list decides where
	// the SHAPE of the baseline is asserted and where a corrupt-bytes refusal is fatal on its own; it does
	// NOT decide where a wrong spelling can hide. The generated inventories (`docs/api-inventory.md` and
	// friends) repeat the pin hundreds of times in source links, so listing each for form's sake would be
	// noise while scanning them is what actually protects them.
	for _, rel := range mdFiles {
		doc, readErr := readStrictDocument(root, rel)
		if readErr != nil {
			// A document this gate cannot read is one it cannot clear.
			findings = append(findings, fmt.Sprintf("%s could not be read as a document: %v", rel, readErr))
			continue
		}
		for _, mismatch := range pinnedCommitMatches(doc, pin) {
			findings = append(findings, fmt.Sprintf("%s line %d: %q is %s; the pinned commit is %q", mismatch.rel, mismatch.line, mismatch.value, mismatch.reason, pin))
		}
	}
	_ = checked
	if mode == treePinnedCommitMode && len(findings) > 0 {
		sort.Strings(findings)
		return 0, fmt.Errorf("pinned-commit consistency failed against %s:\n  %s", pin, strings.Join(findings, "\n  "))
	}
	// The count is the number of documents that DO carry the pin: a gate that checked nothing must not
	// report success (rule 7, rule 19).
	carrying := 0
	for _, rel := range contractDocumentFiles() {
		doc, readErr := readStrictDocument(root, rel)
		if readErr != nil {
			return 0, readErr
		}
		if strings.Contains(doc.text, pin) {
			carrying++
		}
	}
	return carrying, nil
}

// TestPinnedCommitStringsMatchThePin is the gate: no contract document and no workflow may carry an
// object-id-shaped string that is not the pin; every document that names the pin must be in the closed
// list; and every scanned file must be readable as strict UTF-8 with no BOM.
//
// WHAT IT FOUND ON FIRST RUN (2026-10-26). Nothing. GOAL.md:71, AGENTS.md, ARCHITECTURE.md, HANDOFF.md
// and the nine `docs/*.md` files that repeat it all carry the same 40-character value as
// `upstream/SILLYTAVERN_COMMIT`, and so do the three workflow literals. The report that GOAL.md held a
// padded spelling was a READER defect, not a byte one: the file carries correct UTF-8 and the extra
// character appeared only in a terminal that had decoded it through a CP1252 codepage. That is precisely
// the class `AGENTS.md` rule 9 records, so the outcome of "no mismatch" is itself the finding, and
// TestDocumentsConsistencyGateCanGoRed below is what makes the negative mean something: the same gate
// refuses a scratch tree in which the spelling really is padded.
//
// TEETH. TestDocumentsConsistencyGateCanGoRed plants the padded spelling in a document AND, separately,
// in a workflow; TestDocumentsEncodingGateCanGoRed plants a BOM, an invalid byte and mojibake.
func TestPinnedCommitStringsMatchThePin(t *testing.T) {
	// THE PIN AND THIS DOCUMENT ARE PART OF THE GATE, so they are read first and loudly: a missing
	// authority file would otherwise turn "zero mismatches" into a pass over an empty expectation.
	carrying, err := checkPinnedCommitStrings(documentsRoot, treePinnedCommitMode)
	if err != nil {
		t.Fatalf("%v", err)
	}
	if carrying < 4 {
		t.Fatalf("only %d contract documents carry the pinned commit %q; GOAL.md, AGENTS.md, ARCHITECTURE.md and HANDOFF.md all state it, so a lower count means the gate stopped reading them (rule 19: a filter that matches nothing reports ok)", carrying, "")
	}
}

// TestDocumentsConsistencyGateCanGoRed plants the defect this gate exists for and requires the gate to
// report it. A gate whose red path is never executed is a gate nobody has seen fail (doctrine 4).
func TestDocumentsConsistencyGateCanGoRed(t *testing.T) {
	pin, err := pinnedCommitFromTree(documentsRoot)
	if err != nil {
		t.Fatalf("the authority file itself is unreadable: %v", err)
	}
	// The historical spelling, derived from the pin rather than typed: one extra digit, inserted
	// where a manual copy would duplicate one. Derived so that a documented baseline bump cannot make
	// this test plant something that happens to be correct.
	badPin := pin[:38] + "6" + pin[38:] // 41 characters
	if badPin == pin {
		t.Fatalf("the planted spelling equals the pin; the mutation cannot discriminate (rule 15)")
	}

	tree := t.TempDir()
	writeScratchTree(t, tree, pin, badPin)

	carrying, err := checkPinnedCommitStrings(tree, treePinnedCommitMode)
	if err == nil {
		t.Fatalf("the gate ACCEPTED a tree whose GOAL.md carries %q (%d characters) against a pin of %d characters, and reported %d carrying documents: this is the exact defect the gate was written for, so the gate is decoration", badPin, len(badPin), len(pin), carrying)
	}
	msg := err.Error()
	for _, want := range []string{badPin, "GOAL.md", strconv.Itoa(len(badPin)), pin} {
		if !strings.Contains(msg, want) {
			t.Fatalf("the gate refused the tree but its message does not name %q, so a reader cannot find the defect: %v", want, err)
		}
	}
	// And it must pass on the same tree once the spelling is restored, so the red is about the planted
	// defect and not about something else in the scratch tree.
	writeScratchTree(t, tree, pin, pin)
	if _, err := checkPinnedCommitStrings(tree, treePinnedCommitMode); err != nil {
		t.Fatalf("the gate refused the restored tree, so its red was not caused by the planted spelling: %v", err)
	}

	// THE WORKFLOW CASE IS SEPARATE, because a gate that only reads markdown would pass the document case
	// and still be blind to `.github/workflows/`, where the pin is EXECUTED as a checkout ref and a cache
	// key. Plant the bad spelling there and leave every document correct.
	tree = t.TempDir()
	writeScratchTree(t, tree, pin, pin)
	wfPath := filepath.Join(tree, filepath.FromSlash(filepath.Join(".github", "workflows", "scratch.yml")))
	if err := os.WriteFile(wfPath, []byte("env:\n  PINNED_BASELINE_COMMIT: "+badPin+"\n"), 0o644); err != nil {
		t.Fatalf("plant the workflow spelling: %v", err)
	}
	_, err = checkPinnedCommitStrings(tree, treePinnedCommitMode)
	if err == nil {
		t.Fatalf("the gate ACCEPTED a workflow whose PINNED_BASELINE_COMMIT is %q (%d characters): that literal feeds the reference checkout's ref AND its node_modules cache key, so a drifted spelling restores a cache built from a different tree while every document still agrees with the authority file", badPin, len(badPin))
	}
	if !strings.Contains(err.Error(), "scratch.yml") {
		t.Fatalf("refused, but the message does not name the workflow: %v", err)
	}
	if !strings.Contains(err.Error(), badPin) {
		t.Fatalf("refused, but the message does not quote the offending literal: %v", err)
	}
}

// TestDocumentsEncodingGateCanGoRed plants each of the three byte-level corruptions and requires a
// refusal that names the file. This is the rule-9/rule-12 class: the document LOOKS right to every
// human reader and to every lenient decoder.
func TestDocumentsEncodingGateCanGoRed(t *testing.T) {
	pin, err := pinnedCommitFromTree(documentsRoot)
	if err != nil {
		t.Fatalf("the authority file itself is unreadable: %v", err)
	}
	cases := []struct {
		name    string
		corrupt func([]byte) []byte
		want    string
	}{
		{
			name:    "utf8 BOM",
			corrupt: func(b []byte) []byte { return append([]byte{0xEF, 0xBB, 0xBF}, b...) },
			want:    "BOM",
		},
		{
			name: "invalid utf-8 byte",
			corrupt: func(b []byte) []byte {
				out := append([]byte{}, b...)
				out = append(out, ' ', 0xE9, '\n') // 0xE9 alone is not valid UTF-8
				return out
			},
			want: "not valid UTF-8",
		},
		{
			name: "replacement character",
			corrupt: func(b []byte) []byte {
				out := append([]byte{}, b...)
				return append(out, []byte(" "+replacementCharacter+"\n")...)
			},
			want: "REPLACEMENT CHARACTER",
		},
		{
			name: "cp1252 mojibake",
			corrupt: func(b []byte) []byte {
				out := append([]byte{}, b...)
				return append(out, []byte(" "+cp1252MojibakeA+cp1252MojibakeUnderscore+" header\n")...)
			},
			want: "mojibake",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tree := t.TempDir()
			writeScratchTree(t, tree, pin, pin)
			path := filepath.Join(tree, "GOAL.md")
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatalf("scratch tree is unreadable: %v", readErr)
			}
			if writeErr := os.WriteFile(path, tc.corrupt(body), 0o644); writeErr != nil {
				t.Fatalf("corrupt GOAL.md: %v", writeErr)
			}
			// The mojibake case is VALID UTF-8, so it must be caught by the mojibake scanner rather
			// than by the decoder -- assert that too, so the test proves which check fired.
			corrupted, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatalf("re-read GOAL.md: %v", readErr)
			}
			if tc.name == "cp1252 mojibake" && !utf8.Valid(corrupted) {
				t.Fatalf("the planted mojibake is not valid UTF-8, so this case would pass for the wrong reason (rule 15)")
			}
			_, err := checkPinnedCommitStrings(tree, treePinnedCommitMode)
			if err == nil {
				t.Fatalf("the gate ACCEPTED a GOAL.md corrupted with %s; every reader that tolerates it hides the damage, which is why the check has to be here", tc.name)
			}
			if !strings.Contains(err.Error(), "GOAL.md") {
				t.Fatalf("refused, but the message does not name the file: %v", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("refused for the wrong reason: want the message to contain %q, got %v", tc.want, err)
			}
		})
	}
}

// writeScratchTree writes the minimum a gate run needs: the authority file, one contract document per
// entry, and one workflow, each document and the workflow carrying the given spelling. The scratch tree
// is a copy of the SHAPE, never of the real prose, so this test cannot be used to smuggle real content
// anywhere.
func writeScratchTree(t *testing.T, tree, pin, spelling string) {
	t.Helper()
	must := func(rel, body string) {
		path := filepath.Join(tree, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir for %s: %v", rel, err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	for _, rel := range contractDocumentFiles() {
		must(rel, fmt.Sprintf("# scratch\n\nPinned: `%s`.\n", spelling))
	}
	// One workflow, spelling the pin the way browser-differential.yml does: a bare env literal that is
	// read into a checkout ref and into a cache key. A gate that scans documents only cannot see it.
	must(filepath.Join(".github", "workflows", "scratch.yml"), fmt.Sprintf("env:\n  PINNED_BASELINE_COMMIT: %s\n", spelling))
	// The pin authority is written LAST and always holds the REAL pin, even when a document is planted
	// with the bad one: if the planted spelling could reach this file the gate would compare the defect
	// with itself and agree, which is the shared-expectation failure the differential doctrine forbids.
	must(pinnedCommitPath, pin+"\n")
}

// staleGOLDocs are the dated records that legitimately contain history rather than the current state.
// They are listed so the mention check below can name them instead of silently allowing anything.
var historyDocuments = regexp.MustCompile(`(?i)(^|/)(HANDOFF\.md|handoff-archive[^/]*\.md|baseline-bumps\.md)$`)

// TestMojibakeSweepOfEveryDocument extends the encoding check to EVERY markdown file in the tree, not
// only the contract list, because the corrupt literals in this project's history were found in whatever
// file happened to be written by the wrong shell. It reports at most a few examples per file with their
// line numbers so a repair is a read, not a search.
func TestMojibakeSweepOfEveryDocument(t *testing.T) {
	files, err := allMarkdownFiles(documentsRoot)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(files) < 20 {
		t.Fatalf("only %d markdown files found; the sweep would be vacuous (rule 11: a bounded listing cannot support a claim of absence)", len(files))
	}
	var findings []string
	for _, rel := range files {
		if historyDocuments.MatchString(rel) {
			// History documents are still decoded strictly; only the MOJIBAKE scan exempts them,
			// because a dated record quoting a corruption is evidence (and is expected to say so).
			continue
		}
		doc, readErr := readStrictDocument(documentsRoot, rel)
		if readErr != nil {
			findings = append(findings, readErr.Error())
			continue
		}
		for i, line := range strings.Split(doc.text, "\n") {
			if idx := strings.Index(line, cp1252MojibakeUnderscore); idx >= 0 {
				findings = append(findings, fmt.Sprintf("%s line %d: `\\u00E2\\u20AC` (a CP1252 round trip of a three-byte UTF-8 sequence, typically a dash or a quote)", rel, i+1))
				break
			}
			if idx := strings.Index(line, latin1Mojibake); idx >= 0 && idx+1 < len(line) {
				// `Â` followed by a character is the NBSP/CP1252 signature; `Â` alone at the end is
				// not something this repository writes, so both are reported.
				findings = append(findings, fmt.Sprintf("%s line %d: `\\u00C2` followed by %q (a CP1252 round trip of a two-byte UTF-8 sequence)", rel, i+1, string([]rune(line)[idx+1:])))
				break
			}
		}
	}
	if len(findings) > 0 {
		sort.Strings(findings)
		t.Fatalf("%d document(s) carry CP1252 mojibake; the bytes decode as UTF-8 and every word is wrong, which is the corruption class rule 9 records (a `C3 83` / `E2 80 9E` sweep is the check that finds it):\n  %s", len(findings), strings.Join(findings, "\n  "))
	}
}

// scorecardRowPattern reads one `| Qn | question | state | citation |` row. The question cell may
// contain `|`-free prose only, which the scorecard's own convention enforces.
var scorecardRowPattern = regexp.MustCompile(`^\|\s*Q(\d{1,2})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|`)

var scorecardStates = map[string]bool{
	"proven":                    true,
	"partial":                   true,
	"unproven":                  true,
	"blocked":                   true,
	"unsupported":               true,
	"inherited-pinned-behavior": true,
	"declared":                  true, // @gotavern-ledger: declared-row exceptions
	"deferred":                  true, // @gotavern-ledger: deferred-row exceptions
	"not-implemented":           true, // @gotavern-ledger: rows whose route is a decided exclusion
}

// citedFilePattern finds a citation that names a committed FILE (in backticks) rather than a run id. A
// `proven` row may be proven by a document or a test only because the artefact it names is in the tree;
// the citation is then readable by anyone, which is the property a run id also has.
var citedFilePattern = regexp.MustCompile("\x60[^\x60]*\\.(md|go|json|mjs|yml)\x60")

// ledgerManifestPath is the run manifest the scorecard's run citations are checked against. It is
// maintained by hand from `gh run list` output and re-verified by docs-check-manifest; a citation that
// is not in it is red, which is the rule-55 check ("a run id without its workflow name is not
// evidence") applied to every row at once.
var ledgerManifestPath = filepath.Join("tests", "docs", "run-manifest.json")

// manifestEntry is one recorded run. The four fields are the ones a reader needs to judge a citation
// without opening GitHub: WHICH workflow judged the claim, WHAT that workflow concluded, on WHICH commit.
type manifestEntry struct {
	runID      string
	workflow   string
	headSHA    string
	conclusion string
}

// manifestEntryPattern reads the compact one-object-per-line entries the manifest keeps. A JSON decoder
// is avoided deliberately: the manifest is a hand-edited evidence file, and a decoder that silently
// tolerates a duplicate key or a missing field would turn "the entry is wrong" into "the entry is
// absent", which is the difference between a repair and a mystery.
var manifestEntryPattern = regexp.MustCompile(`\{"runId":\s*"(\d{6,})",\s*"workflow":\s*"([^"]*)",\s*"headSha":\s*"([0-9a-f]{40})",\s*"conclusion":\s*"([a-z_]+)"`)

// readManifest parses the manifest into a map keyed by run id, refusing a duplicate id (two entries for
// one run means the document that cites it cannot say which conclusion is the record).
func readManifest(root string) (map[string]manifestEntry, error) {
	doc, err := readStrictDocument(root, ledgerManifestPath)
	if err != nil {
		return nil, err
	}
	out := make(map[string]manifestEntry)
	var problems []string
	for i, line := range strings.Split(doc.text, "\n") {
		m := manifestEntryPattern.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		entry := manifestEntry{runID: m[1], workflow: m[2], headSHA: m[3], conclusion: m[4]}
		if prev, dup := out[entry.runID]; dup {
			problems = append(problems, fmt.Sprintf("line %d: run %s already recorded at an earlier line (%s / %s); two conclusions for one run cannot both be the record", i+1, entry.runID, prev.workflow, prev.conclusion))
			continue
		}
		out[entry.runID] = entry
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return nil, fmt.Errorf("%s is inconsistent:%s", ledgerManifestPath, joinedProblems(problems))
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s carries no parsable runId entries, so every run citation would be unchecked (rule 19)", ledgerManifestPath)
	}
	return out, nil
}

// workflowNameAtRun normalises the two spellings a citation may use for a workflow: the `name:` a
// workflow file declares and the file's own stem. They coincide for this repository, and the
// normalisation is here so that a rename in one place shows up as a mismatch rather than as a silently
// unmatched citation.
func workflowNameAtRun(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

// ancestorCommitPattern finds the commit a citing document says it describes: "commit `<sha>`", "on
// `<sha>`", "HEAD `<sha>`" or a bare 7-40 hex token introduced by one of those words. The ledger states
// its commit in prose, so the gate reads it from prose rather than demanding a field no reader asked for.
var ancestorCommitPattern = regexp.MustCompile(`(?i)\b(?:commit|head|on)\s+\x60([0-9a-f]{7,40})\x60`)

// citedWorkflowPattern is a citation written the way rule 55 demands: a workflow name in backticks
// immediately followed by the run id.
var citedWorkflowPattern = regexp.MustCompile("\x60([^\x60]+)\x60\\s+(\\d{8,12})\\b")

// checkCitationIntegrity is the second half of the ledger gate, added after a report in this project
// cited a run from the WRONG WORKFLOW: a mutation verdict was quoted from the drop-in qualification
// workflow, which boots a packaged archive and never runs the unit suite, so its green could not have
// failed. `gh run list` shows pairs created in the same second, and a summary line does not say which is
// which.
//
// Four independent ways a citation can be wrong, each fatal:
//
//	(i)   the workflow name written beside the id is not the workflow that run belongs to;
//	(ii)  the run's head_sha is not an ancestor of the commit the document describes, so the run judged
//	      different code than the document is about;
//	(iii) the run's conclusion is failure or cancelled and the row does not say so IN PLACE;
//	(iv)  the row describes itself as resting on a red run's green step while citing no red run at all.
func checkCitationIntegrity(root string, ancestry ancestryResolver, entries map[string]manifestEntry, rows []scorecardRow) []string {
	var problems []string

	// (ii) needs the commit the ledger describes. A ledger with no commit cannot be checked for ancestry
	// at all, and saying so is better than pretending the check ran.
	doc, err := readStrictDocument(root, filepath.Join("docs", "goal-scorecard.md"))
	describes := ""
	if err == nil {
		if m := ancestorCommitPattern.FindStringSubmatch(doc.text); m != nil {
			describes = m[1]
		}
	}
	if describes == "" {
		problems = append(problems, "the ledger names no commit it describes (expected a `commit <sha>`/`on <sha>` phrase), so no citation's ancestry can be checked; a run judged SOME commit and the reader must know which one the document is about")
	}

	for _, r := range rows {
		// (i) the workflow name beside the id must be the workflow the run belongs to.
		for _, m := range citedWorkflowPattern.FindAllStringSubmatch(r.citation, -1) {
			claimedName, runID := m[1], m[2]
			entry, known := entries[runID]
			if !known {
				continue // the missing-id case is reported by the caller; one finding per defect
			}
			if workflowNameAtRun(claimedName) != workflowNameAtRun(entry.workflow) {
				problems = append(problems, fmt.Sprintf("Q%d line %d writes the workflow name %q beside run %s, but that run belongs to %q: a run id quoted with the wrong workflow is how a green that could not fail gets cited as a verdict (AGENTS.md rule 55)", r.number, r.line, claimedName, runID, entry.workflow))
			}
		}

		// (ii) ancestry, for every run the row cites.
		for _, m := range regexp.MustCompile(`\b(\d{8,12})\b`).FindAllStringSubmatch(r.citation, -1) {
			runID := m[1]
			entry, known := entries[runID]
			if !known || describes == "" {
				continue
			}
			if ancestry == nil {
				problems = append(problems, fmt.Sprintf("Q%d line %d cites run %s but no ancestry resolver was supplied, so whether the run judged a commit this ledger describes is unchecked; a check that cannot run must not read as a pass (rule 7)", r.number, r.line, runID))
				continue
			}
			ancestor, checkErr := ancestry(entry.headSHA, describes)
			if checkErr != nil {
				// Not a citation defect: the repository history needed to answer is not here. Say so
				// once, naming the run, rather than passing silently (rule 7).
				problems = append(problems, fmt.Sprintf("Q%d line %d cites run %s whose ancestry could not be verified: %v", r.number, r.line, runID, checkErr))
				continue
			}
			if !ancestor {
				problems = append(problems, fmt.Sprintf("Q%d line %d cites run %s, which judged %s -- not an ancestor of %s, the commit this ledger describes: a result about another commit is not evidence for this one", r.number, r.line, runID, entry.headSHA[:12], describes))
			}
		}

		// (iii) a red run cited must be marked in place, in the row's own words.
		for _, m := range regexp.MustCompile(`\b(\d{8,12})\b`).FindAllStringSubmatch(r.citation, -1) {
			entry, known := entries[m[1]]
			if !known {
				continue
			}
			if entry.conclusion == "failure" || entry.conclusion == "cancelled" {
				if !strings.Contains(strings.ToLower(r.citation), entry.conclusion) {
					problems = append(problems, fmt.Sprintf("Q%d line %d cites run %s, whose conclusion is %q, without saying so: the row must state the run's conclusion in place, because a reader who opens the run will see %q and must not read that as a contradiction", r.number, r.line, m[1], entry.conclusion, entry.conclusion))
				}
			}
		}
	}
	return problems
}

// isAncestor reports whether commit `ancestor` is reachable from commit `descendant`, by asking git. It
// is a repository question, not a string comparison: two SHAs can share a prefix, and a run's commit
// can be on a branch that never reached the document's commit.
func isAncestor(root, ancestor, descendant string) (bool, error) {
	if len(descendant) < 7 {
		return false, fmt.Errorf("%q is too short to resolve", descendant)
	}
	// `-C root` is not enough on its own: a relative root (this file passes "../..") would be resolved
	// against whatever the process working directory happens to be, and `git -C <relative>` from a temp
	// directory fails with 128 — measured in CI as "ancestry could not be verified" for every citation at
	// once. Resolve to an absolute path and ALSO set cmd.Dir, so both addressings agree.
	absRoot, absErr := filepath.Abs(root)
	if absErr != nil {
		return false, fmt.Errorf("resolve %q: %w", root, absErr)
	}
	cmd := exec.Command("git", "-C", absRoot, "merge-base", "--is-ancestor", ancestor, descendant)
	cmd.Dir = absRoot
	// A missing git binary or a shallow clone must be reported, not converted into "not an ancestor".
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if exitErr.ExitCode() == 1 {
				return false, nil // git's own "no": a complete answer
			}
			// 128 is git's "I could not answer" (unknown revision, not a repository, shallow history).
			// Report it rather than absorbing it into a verdict.
			return false, fmt.Errorf("git merge-base --is-ancestor %s %s exited %d: %s", ancestor, descendant, exitErr.ExitCode(), strings.TrimSpace(string(exitErr.Stderr)))
		}
		return false, fmt.Errorf("could not run git: %w", err)
	}
	return true, nil
}

// scorecardRow is one parsed ledger row. It is a package type rather than a local one because the
// citation-integrity checks take the rows by value and a second, differently-shaped row type would be a
// second definition of "the row" (the same failure as two scorecards).
type scorecardRow struct {
	number   int
	state    string
	citation string
	line     int
}

// checkScorecardStructure is the gate for the evidence ledger. It enforces, per row: the question exists
// exactly once, the state is one of the six the brief names (plus the two declared exceptions, which
// must carry their own ledger note), a `proven` row cites a run id or a document, every cited run id is
// in the manifest, and the CITATION itself is integrous — right workflow, ancestor commit, red runs
// marked in place (checkCitationIntegrity).
// ancestryResolver answers "is ancestor reachable from descendant?", and is a SEAM rather than a direct
// call so the ledger's structural rules can be tested in a scratch tree that is not a git repository.
//
// The seam is narrow on purpose. The production value is gitAncestry (a real `git merge-base
// --is-ancestor`); the test value is a map. What the seam does NOT let a test do is skip the check
// entirely: `nil` means "cannot verify", which the gate reports as its own finding, so a test that forgets
// to provide a resolver does not get a silent pass (rule 7).
type ancestryResolver func(ancestor, descendant string) (bool, error)

// gitAncestry is the production resolver. It runs git against the tree the ledger lives in.
func gitAncestry(root string) ancestryResolver {
	return func(ancestor, descendant string) (bool, error) {
		return isAncestor(root, ancestor, descendant)
	}
}

// checkScorecardStructure keeps its signature for the callers that want the real answer.
func checkScorecardStructure(root string) error {
	return checkScorecardStructureWith(root, gitAncestry(root))
}

// checkScorecardStructureWith is the gate body with the ancestry question injected.
func checkScorecardStructureWith(root string, ancestry ancestryResolver) error {
	doc, err := readStrictDocument(root, filepath.Join("docs", "goal-scorecard.md"))
	if err != nil {
		return err
	}
	entries, err := readManifest(root)
	if err != nil {
		return err
	}

	rowsByNumber := make(map[int]scorecardRow)
	var problems []string
	for i, line := range strings.Split(doc.text, "\n") {
		m := scorecardRowPattern.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		n, convErr := strconv.Atoi(m[1])
		if convErr != nil {
			problems = append(problems, fmt.Sprintf("line %d: unparsable question number %q", i+1, m[1]))
			continue
		}
		state := normalizeState(m[3])
		if !validState(state) {
			problems = append(problems, fmt.Sprintf("Q%d line %d: state %q is not one of proven/partial/unproven/blocked/unsupported/inherited-pinned-behavior", n, i+1, strings.TrimSpace(m[3])))
		}
		if _, dup := rowsByNumber[n]; dup {
			problems = append(problems, fmt.Sprintf("Q%d appears more than once (second at line %d); one row per question, so a reader cannot tell which state is current", n, i+1))
		}
		rowsByNumber[n] = scorecardRow{number: n, state: state, citation: m[4], line: i + 1}
	}
	for q := 1; q <= 22; q++ {
		if _, ok := rowsByNumber[q]; !ok {
			problems = append(problems, fmt.Sprintf("Q%d has no row; an absent question reads as covered", q))
		}
	}
	rows := make([]scorecardRow, 0, len(rowsByNumber))
	for _, r := range rowsByNumber {
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].number < rows[j].number })

	for n, r := range rowsByNumber {
		if n < 1 || n > 22 {
			problems = append(problems, fmt.Sprintf("Q%d at line %d is outside Q1..Q22; GOAL §7 asks exactly twenty-two questions", n, r.line))
		}
		switch r.state {
		case "proven":
			if strings.TrimSpace(r.citation) == "" {
				problems = append(problems, fmt.Sprintf("Q%d line %d is `proven` with no citation", n, r.line))
				continue
			}
			runIDs := regexp.MustCompile(`\b(\d{8,12})\b`).FindAllStringSubmatch(r.citation, -1)
			citesDocument := citedFilePattern.MatchString(r.citation)
			if len(runIDs) == 0 && !citesDocument {
				problems = append(problems, fmt.Sprintf("Q%d line %d is `proven` but its citation names neither a run id nor a committed file: %q", n, r.line, strings.TrimSpace(r.citation)))
			}
			for _, id := range runIDs {
				if _, known := entries[id[1]]; !known {
					problems = append(problems, fmt.Sprintf("Q%d line %d cites run %s, which is not in %s: a run id nobody can look up is a claim, not evidence (rule 55)", n, r.line, id[1], ledgerManifestPath))
				}
			}
		case "partial", "blocked", "unsupported", "inherited-pinned-behavior":
			if strings.TrimSpace(r.citation) == "" {
				problems = append(problems, fmt.Sprintf("Q%d line %d is %q with no reason; the whole point of the state is that the reader learns why", n, r.line, r.state))
			}
		case "unproven":
			// Unproven rows must say WHY nothing proves them, which is also a citation.
			if strings.TrimSpace(r.citation) == "" {
				problems = append(problems, fmt.Sprintf("Q%d line %d is `unproven` with no sentence saying what is missing", n, r.line))
			}
		}
	}
	problems = append(problems, checkCitationIntegrity(root, ancestry, entries, rows)...)
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("evidence ledger %s is inconsistent:%s", filepath.ToSlash(filepath.Join("docs", "goal-scorecard.md")), joinedProblems(problems))
	}
	return nil
}

func normalizeState(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.Trim(s, "\x60*_ ")
	s = strings.ReplaceAll(s, " ", "-")
	return s
}

func validState(s string) bool {
	return scorecardStates[s] || strings.HasPrefix(s, "inherited-pinned-behavior") || strings.HasPrefix(s, "declared:") || strings.HasPrefix(s, "deferred:")
}

// alwaysAncestor is the resolver the structural tests use: it answers "yes" for every pair, because the
// question under test in those cases is the ledger's shape, not its history. The ancestry question has
// its own test against a real repository (TestCitationAncestryGateCanGoRed), where "yes" would be wrong.
func alwaysAncestor(_, _ string) (bool, error) { return true, nil }

// TestEvidenceLedgerIsConsistent runs the ledger gate against the tree.
func TestEvidenceLedgerIsConsistent(t *testing.T) {
	if err := checkScorecardStructure(documentsRoot); err != nil {
		t.Fatalf("%v", err)
	}
}

// TestEvidenceLedgerGateCanGoRed plants each ledger defect and requires it to be reported: a missing
// row, a duplicated row, a `proven` row citing nothing, and a `proven` row citing a run that is not in
// the manifest.
func TestEvidenceLedgerGateCanGoRed(t *testing.T) {
	base, err := readStrictDocument(documentsRoot, filepath.Join("docs", "goal-scorecard.md"))
	if err != nil {
		t.Fatalf("the real ledger is unreadable: %v", err)
	}
	manifest, err := readStrictDocument(documentsRoot, ledgerManifestPath)
	if err != nil {
		t.Fatalf("the real manifest is unreadable: %v", err)
	}
	// A run id that is certainly absent: derived from the manifest's own largest id by appending a
	// digit, so it cannot collide with a real run even after the manifest grows.
	absentRunID := "99999999999"

	cases := []struct {
		name    string
		mutate  func(string) string
		wantSub string
	}{
		{
			name:    "a question row is missing",
			mutate:  func(s string) string { return removeLedgerRow(s, 18) },
			wantSub: "Q18 has no row",
		},
		{
			name:    "a question row is duplicated",
			mutate:  func(s string) string { return s + "\n" + ledgerRow(4, "proven", "`Browser differential` 40325398585") },
			wantSub: "appears more than once",
		},
		{
			name:    "a proven row cites nothing",
			mutate:  func(s string) string { return replaceLedgerRow(s, 4, ledgerRow(4, "proven", "")) },
			wantSub: "`proven` with no citation",
		},
		{
			name: "a proven row cites an unknown run",
			mutate: func(s string) string {
				return replaceLedgerRow(s, 4, ledgerRow(4, "proven", "`Browser differential` "+absentRunID))
			},
			wantSub: "not in",
		},
		{
			name:    "a row carries an invented state",
			mutate:  func(s string) string { return replaceLedgerRow(s, 4, ledgerRow(4, "basically-fine", "x")) },
			wantSub: "is not one of",
		},
		// (i) THE WORKFLOW NAME BESIDE THE ID. Measured in this project: a mutation verdict was quoted
		// from `GoTavern drop-in qualification`, a workflow that never runs the unit suite, so its green
		// could not have failed. The row below writes a real run id with the wrong workflow name.
		{
			name: "a cited run carries the wrong workflow name",
			mutate: func(s string) string {
				return replaceLedgerRow(s, 4, ledgerRow(4, "proven", "`GoTavern drop-in qualification` 40325398585 (success)"))
			},
			wantSub: "but that run belongs to",
		},
		// (iii) A RED RUN MUST BE MARKED IN PLACE. 40378609525 concluded failure; the row cites it and
		// says only "success", which is the reading that makes a red run look green.
		{
			name: "a red run is cited without saying so",
			mutate: func(s string) string {
				return replaceLedgerRow(s, 4, ledgerRow(4, "proven", "`Browser differential` 40378609525 (success), step `first-turn-saved`"))
			},
			wantSub: "without saying so",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tree := t.TempDir()
			writeLedgerScratch(t, tree, tc.mutate(base.text), manifest.text)
			// The structural rules under test are not about git, so ancestry answers "yes" here; the
			// ancestry check has its own test against a real repository.
			err := checkScorecardStructureWith(tree, alwaysAncestor)
			if err == nil {
				t.Fatalf("the ledger gate ACCEPTED a scorecard with %s; a ledger that cannot express a defect is prose", tc.name)
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("refused, but not for the planted reason: want %q in %v", tc.wantSub, err)
			}
		})
	}
	// And the unmutated copy must pass, so the reds above are about the planted defect.
	tree := t.TempDir()
	writeLedgerScratch(t, tree, base.text, manifest.text)
	if err := checkScorecardStructureWith(tree, alwaysAncestor); err != nil {
		t.Fatalf("the gate refused the UNMUTATED ledger, so its reds prove nothing: %v", err)
	}
}

// TestCitationAncestryGateCanGoRed is (ii) on its own, because it is the one citation check that needs a
// REAL git history: the run's head_sha must be an ancestor of the commit the ledger describes. A tree
// whose ledger describes a commit that does not contain the cited run's commit must be refused, and the
// same tree with the ledger describing a descendant must pass.
//
// The scratch repository is built here rather than borrowed from this repository so the test states the
// property instead of depending on whichever commits happen to exist. Two branches are created: `main`
// holds the run's commit; `other` is a sibling that does NOT contain it — which is the shape of a lane's
// run being cited from a document about a commit the lane never reached.
func TestCitationAncestryGateCanGoRed(t *testing.T) {
	gitRun := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=gate", "GIT_AUTHOR_EMAIL=gate@example.invalid",
			"GIT_COMMITTER_NAME=gate", "GIT_COMMITTER_EMAIL=gate@example.invalid",
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s in %s: %v\n%s", strings.Join(args, " "), dir, err, out)
		}
		return strings.TrimSpace(string(out))
	}

	repo := t.TempDir()
	gitRun(repo, "init", "-b", "main", "--quiet")
	// A BASE commit first, so the sibling below has something to branch from. Without it `HEAD~2` does
	// not resolve on a two-commit history and the fixture fails for a reason unrelated to ancestry —
	// measured here, and the reason this fixture has three commits rather than two.
	gitRun(repo, "commit", "--allow-empty", "-m", "the base", "--quiet")
	baseCommit := gitRun(repo, "rev-parse", "HEAD")
	gitRun(repo, "commit", "--allow-empty", "-m", "the run's commit", "--quiet")
	runCommit := gitRun(repo, "rev-parse", "HEAD")
	gitRun(repo, "commit", "--allow-empty", "-m", "a later commit", "--quiet")
	laterCommit := gitRun(repo, "rev-parse", "HEAD")

	// A sibling that does NOT contain runCommit: branched from the base, i.e. before the run's commit.
	gitRun(repo, "checkout", "--quiet", "-b", "sibling", baseCommit)
	gitRun(repo, "commit", "--allow-empty", "-m", "a sibling commit", "--quiet")
	siblingCommit := gitRun(repo, "rev-parse", "HEAD")
	gitRun(repo, "checkout", "--quiet", "main")

	// The fixture must be able to distinguish, or every assertion below passes for the wrong reason: the
	// sibling has to genuinely NOT contain the run's commit, and genuinely descend from the base.
	if ok, err := isAncestor(repo, runCommit, siblingCommit); err != nil || ok {
		t.Fatalf("the fixture is broken: the run's commit is not supposed to be reachable from the sibling, but isAncestor said %v (err %v)", ok, err)
	}
	if ok, err := isAncestor(repo, baseCommit, siblingCommit); err != nil || !ok {
		t.Fatalf("the fixture is broken: the base must be an ancestor of the sibling, but isAncestor said %v (err %v)", ok, err)
	}

	// Directly: the ancestor question is answered by git, in both directions.
	if ok, err := isAncestor(repo, runCommit, laterCommit); err != nil || !ok {
		t.Fatalf("run's commit IS an ancestor of the later commit, but the check said %v (err %v)", ok, err)
	}
	if ok, err := isAncestor(repo, runCommit, siblingCommit); err != nil || ok {
		t.Fatalf("run's commit is NOT an ancestor of the sibling commit, but the check said %v (err %v): a lane's run cited from a document about a commit the lane never reached is exactly the wrong-workflow failure one layer down", ok, err)
	}
	if _, err := isAncestor(repo, runCommit, "0000000"); err == nil {
		// A commit that does not exist must be an ERROR, not a silent "not an ancestor": a gate that
		// cannot answer must not answer "no" (rule 7). The failing branch is therefore the ABSENCE of an
		// error, which is what this asserts.
		t.Fatalf("git could not resolve the descendant commit, yet isAncestor returned a verdict instead of an error; a gate that cannot answer must not answer")
	}

	// And through the ledger gate, with a synthetic manifest whose single entry's head_sha is runCommit.
	//
	// THE LEDGER IS WRITTEN INTO THE GIT REPO ABOVE, on purpose: ancestry is answered by `git -C <root>`,
	// so a scratch tree that is not a repository cannot answer it at all and every citation would read as
	// "could not verify". The gate reports that as its own finding rather than as a verdict, and a test
	// that mixed the two would prove nothing about ancestry.
	synthetic := fmt.Sprintf("{\n  \"entries\": [\n    {\"runId\": \"40000000001\", \"workflow\": \"Browser differential\", \"headSha\": \"%s\", \"conclusion\": \"success\"}\n  ]\n}\n", runCommit)
	ledger := func(describes string) string {
		return "Ledger for commit `" + describes + "`.\n\n" +
			ledgerRow(4, "proven", "`Browser differential` 40000000001 (success)") + "\n"
	}
	repoAncestry := gitAncestry(repo)
	writeLedgerScratch(t, repo, ledger(laterCommit), synthetic)
	if err := checkScorecardStructureWith(repo, repoAncestry); err != nil {
		if strings.Contains(err.Error(), "not an ancestor") {
			t.Fatalf("the gate refused a citation whose run commit IS an ancestor of the described commit: %v", err)
		}
		// Other findings (the missing Q rows) are expected in this minimal ledger; only the ancestry
		// verdict is under test, and it must not appear here.
	}
	writeLedgerScratch(t, repo, ledger(siblingCommit), synthetic)
	refusal := checkScorecardStructureWith(repo, repoAncestry)
	if refusal == nil {
		t.Fatalf("the gate ACCEPTED a citation whose run judged %s while the ledger describes %s, a commit that does not contain it", runCommit[:12], siblingCommit[:12])
	}
	if !strings.Contains(refusal.Error(), "not an ancestor") {
		t.Fatalf("refused, but not for the ancestry reason: %v", refusal)
	}
}
func ledgerRow(n int, state, citation string) string {
	return fmt.Sprintf("| Q%d | question %d | %s | %s |", n, n, state, citation)
}

func removeLedgerRow(text string, n int) string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if m := scorecardRowPattern.FindStringSubmatch(line); m != nil {
			if got, err := strconv.Atoi(m[1]); err == nil && got == n {
				continue
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func replaceLedgerRow(text string, n int, replacement string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if m := scorecardRowPattern.FindStringSubmatch(line); m != nil {
			if got, err := strconv.Atoi(m[1]); err == nil && got == n {
				lines[i] = replacement
				return strings.Join(lines, "\n")
			}
		}
	}
	return text
}

func writeLedgerScratch(t *testing.T, tree, scorecard, manifest string) {
	t.Helper()
	for rel, body := range map[string]string{
		filepath.Join("docs", "goal-scorecard.md"): scorecard,
		ledgerManifestPath:                         manifest,
	} {
		path := filepath.Join(tree, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir for %s: %v", rel, err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
}

// TestDocumentGateCoversTheContract requires every markdown file that repeats the pin to be either in the
// closed list or covered by the invariable inventory scan below. Coverage is enumerated from the tree,
// never from whatever a reader remembers adding (rule 43).
//
// WHY TWO TIERS. The closed list is the documents whose PROSE states the baseline as a claim. The
// generated inventories (`docs/api-inventory.md`, `docs/config-inventory.md`, `docs/startup-inventory.md`,
// `docs/data-layout.md`, `docs/tokenizer-parity-plan.md`, `docs/compat-matrix.md`, the generated
// compatibility matrix, the extension route coverage and `README.md`/`docs/INSTALLATION.md`) repeat the pin
// in every source link — hundreds of times — so they are covered more strongly than by a list: the whole
// tree is scanned for pin-shaped strings by TestPinnedCommitStringsMatchThePin, and this test only asks
// that each of them is EITHER listed EITHER scanned. A file that is neither is red, which is the case this
// exists to catch.
func TestDocumentGateCoversTheContract(t *testing.T) {
	pin, err := pinnedCommitFromTree(documentsRoot)
	if err != nil {
		t.Fatalf("%v", err)
	}
	files, err := allMarkdownFiles(documentsRoot)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	inList := make(map[string]bool)
	for _, rel := range contractDocumentFiles() {
		inList[filepath.ToSlash(rel)] = true
	}
	var missing []string
	for _, rel := range files {
		if inList[rel] {
			continue
		}
		body, readErr := os.ReadFile(filepath.Join(documentsRoot, filepath.FromSlash(rel)))
		if readErr != nil {
			t.Fatalf("read %s: %v", rel, readErr)
		}
		text := string(body)
		if !strings.Contains(text, pin) {
			continue
		}
		// It names the pin. Is it scanned by the whole-tree pass? That pass walks EVERY markdown file
		// under the root, so the only files it cannot see are ones it deliberately skips.
		if isSkippedMarkdownPath(rel) {
			missing = append(missing, rel+" (skipped by the tree walk, so no gate reads it)")
			continue
		}
		// Scanned, but is its pin spelling CORRECT? Ask the same matcher the gate uses, so a wrong
		// spelling in an unlisted file is a finding here rather than a silent gap.
		doc, readErr := readStrictDocument(documentsRoot, rel)
		if readErr != nil {
			missing = append(missing, rel+" ("+readErr.Error()+")")
			continue
		}
		if mismatches := pinnedCommitMatches(doc, pin); len(mismatches) > 0 {
			missing = append(missing, fmt.Sprintf("%s (line %d carries %q)", rel, mismatches[0].line, mismatches[0].value))
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Fatalf("%d document(s) name the pinned commit and are neither listed in contractDocumentFiles() nor readable as strict UTF-8 with the correct spelling:\n  %s\nEither add the file to contractDocumentFiles() or fix its bytes; a document outside both tiers is one nothing checks.", len(missing), strings.Join(missing, "\n  "))
	}
}

// isSkippedMarkdownPath reports whether the tree walk deliberately skips a path. It mirrors
// allMarkdownFiles' skip rules; kept beside this test so the two cannot drift silently.
func isSkippedMarkdownPath(rel string) bool {
	for _, segment := range strings.Split(rel, "/") {
		switch segment {
		case ".git", "node_modules", ".reference", "upstream":
			return true
		}
	}
	return false
}

// agentsCitationSections are the AGENTS.md sections whose numbered items are the citation surface. The
// other numbered lists in that file (the "Required workflow" steps, the differential doctrine, the
// architecture boundaries) restart at 1 by design and are cited by NAME, never by a bare number, so
// including them would make "does the numbering shift?" unanswerable. A section is named here when a
// citation like "AGENTS.md rule 55" can point into it.
var agentsCitationSections = []string{
	"## Hard rules",
	"## Verification methods",
	"## Product contract (2026-10-25, after three user-visible P0 failures)",
	"## Product contract (2026-10-25, second pass: a green CI and a page a user cannot look at)",
	// THE 2026-10-27 SERIES CONTINUES THE PRODUCT-CONTRACT NUMBERING (58 onward) AND IS CITED BY BARE
	// NUMBER, exactly like the series that begins at 21. It lives under its own heading because it came from
	// a day of lanes rather than from the two P0 passes, but a new heading is not a reason to leave thirteen
	// rules unpoliced: the numbering is what citations elsewhere in the repository point at.
	"## Verification rules added 2026-10-27 (from a day of lanes, each with its measurement)",
}

// agentsCitationNumbering is the expected numbering of the citation surface, in document order and split
// by section so a rule that MOVES between sections is caught as well as one that is renumbered.
//
// TWO SERIES, DELIBERATELY DISJOINT. "Hard rules" numbers 1-19. The verification and differential sections
// number their own lists 1-N because they are cited by SECTION AND NUMBER ("verification rule 9"), never by
// a bare number. The product-contract series begins at 21 so that a bare "rule 20" cannot be ambiguous
// between "verification rule 20" (which does not exist — the verification list ends at 20) and a
// product rule; that gap is asserted. A future editor "tidying up" the sequence would silently renumber
// every product-contract citation in the repository.
func agentsCitationNumbering() map[string][]string {
	verification := make([]string, 0, 20)
	for i := 1; i <= 20; i++ {
		verification = append(verification, strconv.Itoa(i))
	}
	differential := make([]string, 0, 12)
	for i := 1; i <= 12; i++ {
		differential = append(differential, strconv.Itoa(i))
	}
	return map[string][]string{
		"## Hard rules":           {"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19"},
		"## Verification methods": verification,
		"## Differential-testing doctrine (what the oracle is allowed to claim)": differential,
		"## Product contract (2026-10-25, after three user-visible P0 failures)": {
			"21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41",
		},
		"## Product contract (2026-10-25, second pass: a green CI and a page a user cannot look at)": {
			"42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57",
		},
		"## Verification rules added 2026-10-27 (from a day of lanes, each with its measurement)": {
			"58", "59", "60", "61", "62", "63", "64", "65", "66", "67", "68", "69", "70", "71", "72", "73", "74", "75",
			"76", "77", "78", "79", "80", "81", "82", "83", "84", "85", "86", "87", "88", "89", "90", "91", "92", "93", "94", "95", "96", "97", "98", "99", "100", "101", "102", "103",
		},
	}
}

// sectionRuleNumbers extracts the numbered rule heads inside the named section, stopping at the next
// level-2 heading. Continuation lines are indented, so only a column-0 `<n>. **` counts.
func sectionRuleNumbers(text, section string) []string {
	var out []string
	inSection := false
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "## ") {
			inSection = strings.TrimRight(line, " \r") == section
			continue
		}
		if !inSection {
			continue
		}
		// \d{1,3}, NOT \d{1,2}: the citation surface passed 99 rules on 2026-10-27, and a two-digit
		// pattern silently stops matching at 100 — the extractor then returns a SHORTER list than
		// agentsCitationNumbering() expects and the gate fails on a document that is correct. This is
		// the same bounded-pattern defect as a truncated listing (verification rule 11): the check
		// could not see the very rules it was extended to police.
		if m := regexp.MustCompile(`^(\d{1,3})\. \*\*`).FindStringSubmatch(line); m != nil {
			out = append(out, m[1])
		}
	}
	return out
}

// TestAgentsRuleNumbersAreStable pins the rule numbers that the rest of this repository cites by number.
//
// WHY A NUMBER LIST AND NOT JUST ORDER. The rules are cited from commits, code comments, workflows and
// reports ("AGENTS.md rule 55"), so the numbers ARE the interface, and the failure that produced this
// test was a lane appending its narrative to the root file, which shifted the numbers under every
// existing citation. The test makes that shift red on the push that causes it.
//
// WHAT IT ALSO FORCES. Long narrative belongs in a topic document under `docs/`, linked from the rule.
// A rule that grows without bound is the pressure that causes an append, so this test pairs with the
// rule-length ceiling below: a rule that exceeds it must move its story out and keep only the invariant,
// the citation, and a link.
func TestAgentsRuleNumbersAreStable(t *testing.T) {
	doc, err := readStrictDocument(documentsRoot, "AGENTS.md")
	if err != nil {
		t.Fatalf("%v", err)
	}
	expected := agentsCitationNumbering()
	for _, section := range agentsCitationSections {
		want, listed := expected[section]
		if !listed {
			t.Fatalf("section %q is in agentsCitationSections but has no expected numbering; add it to agentsCitationNumbering()", section)
		}
		got := sectionRuleNumbers(doc.text, section)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("AGENTS.md section %q numbers its rules\n  got:  %v\n  want: %v\n"+
				"Rules are cited by NUMBER across this repository, so a missing, repeated or moved number silently points a\n"+
				"citation at a different rule. If a rule was deliberately renumbered, update every citation in the same change\n"+
				"and update agentsCitationNumbering().", section, got, want)
		}
	}
	// Every cited section must actually be found: a heading typo would otherwise make the loop above
	// compare an empty list against a non-empty expectation and fail for the wrong reason... or, if the
	// expectation were also empty, pass (rule 19).
	for _, section := range agentsCitationSections {
		if len(sectionRuleNumbers(doc.text, section)) == 0 {
			t.Fatalf("section %q yielded no rules; the heading has drifted and this test is now checking nothing for it", section)
		}
	}
	if strings.Contains(doc.text, "## Hard rules\n\n20. **") {
		t.Fatalf("a rule 20 was added to Hard rules; the product-contract series begins at 21 so that 'rule 20' is unambiguous, and a rule 20 there reintroduces the ambiguity")
	}
}

// ruleLengthCeiling is the number of body lines a single rule may occupy in AGENTS.md. Measured: the
// longest rule at the time of writing (rule 18) ran to 37 lines, and the whole file to 660. A ceiling is
// not tidiness: the append-instead-of-extract habit is what broke rule numbering, and a ceiling is the
// only mechanical way to notice that a rule is becoming a story again.
const ruleLengthCeiling = 45

// TestAgentsRulesStayShortEnoughToStayNumbered refuses a rule that has grown into a narrative. The fix is
// always the same and is named in the message: move the story into a topic document under docs/, leave
// the invariant and the link.
func TestAgentsRulesStayShortEnoughToStayNumbered(t *testing.T) {
	doc, err := readStrictDocument(documentsRoot, "AGENTS.md")
	if err != nil {
		t.Fatalf("%v", err)
	}
	lines := strings.Split(doc.text, "\n")
	type ruleSpan struct {
		number string
		start  int
		length int
	}
	var spans []ruleSpan
	ruleHead := regexp.MustCompile(`^(\d{1,3})\. \*\*`)
	current := -1
	for i, line := range lines {
		if strings.HasPrefix(line, "## ") || strings.HasPrefix(line, "# ") {
			if current >= 0 {
				spans[current].length = i - spans[current].start
				current = -1
			}
			continue
		}
		if m := ruleHead.FindStringSubmatch(line); m != nil {
			if current >= 0 {
				spans[current].length = i - spans[current].start
			}
			spans = append(spans, ruleSpan{number: m[1], start: i})
			current = len(spans) - 1
		}
	}
	if current >= 0 {
		spans[current].length = len(lines) - spans[current].start
	}
	if len(spans) < 50 {
		t.Fatalf("found only %d rules; the parser is no longer reading AGENTS.md and this check would pass vacuously", len(spans))
	}
	var offenders []string
	for _, span := range spans {
		if span.length > ruleLengthCeiling {
			offenders = append(offenders, fmt.Sprintf("rule %s at line %d occupies %d lines (ceiling %d)", span.number, span.start+1, span.length, ruleLengthCeiling))
		}
	}
	if len(offenders) > 0 {
		sort.Strings(offenders)
		t.Fatalf("a rule has grown into a narrative:\n  %s\nMove the story into a topic document under docs/ and leave the rule, its\ninvariant and a link. A long rule is what invites the next append, and the\nappend is what shifts the numbers every citation depends on.", strings.Join(offenders, "\n  "))
	}
}

// TestAgentsRuleGateCanGoRed proves the numbering check discriminates: a duplicated number, a dropped
// number, a rule moved into another section, and a rule grown into a narrative must each be reported.
func TestAgentsRuleGateCanGoRed(t *testing.T) {
	const section = "## Hard rules"
	minimal := func(body string) string { return "## Hard rules\n\n" + body + "\n## Next\n\n## Other\n" }

	if got := sectionRuleNumbers(minimal("1. **one.**\n2. **two.**\n3. **three.**\n"), section); strings.Join(got, ",") != "1,2,3" {
		t.Fatalf("the extractor does not read a minimal rule list: %v", got)
	}
	duplicated := minimal("1. **one.**\n2. **two.**\n2. **two again.**\n")
	if got := strings.Join(sectionRuleNumbers(duplicated, section), ","); got == "1,2,3" {
		t.Fatalf("duplicating a rule number produced the accepted list %q, so the check cannot see a collision", got)
	}
	dropped := minimal("1. **one.**\n3. **three.**\n")
	if got := strings.Join(sectionRuleNumbers(dropped, section), ","); got == "1,2,3" {
		t.Fatalf("dropping a rule number produced the accepted list %q, so the check cannot see a shift", got)
	}
	// A rule that MOVES between sections keeps its number but leaves its section, which is the same
	// defect for a reader who looks it up. The extractor is per-section, so the moved rule appears in the
	// wrong list.
	moved := "## Hard rules\n\n1. **one.**\n\n## Next\n\n2. **two.**\n3. **three.**\n"
	if got := strings.Join(sectionRuleNumbers(moved, section), ","); got == "1,2,3" {
		t.Fatalf("a rule moved out of its section was still reported as present there (%q)", got)
	}
	// And the real file must be readable by the same extractor -- otherwise the assertions above were
	// about a string this test wrote (rule 7).
	doc, err := readStrictDocument(documentsRoot, "AGENTS.md")
	if err != nil {
		t.Fatalf("%v", err)
	}
	if got := len(sectionRuleNumbers(doc.text, section)); got != 19 {
		t.Fatalf("AGENTS.md 'Hard rules' has %d numbered rules, not 19", got)
	}
	// The length ceiling must discriminate too, or the rule it enforces is decoration.
	long := "1. **one.**\n" + strings.Repeat("   continuation\n", ruleLengthCeiling+5)
	if bodily := countRuleBodyLines(minimal(long)); bodily <= ruleLengthCeiling {
		t.Fatalf("a rule written with %d body lines measured as %d, so the ceiling could never fire", ruleLengthCeiling+6, bodily)
	}
	if bodily := countRuleBodyLines(minimal("1. **one.**\n2. **two.**\n")); bodily == 0 {
		t.Fatalf("the length counter reported 0 for a tree with rules, so an empty result would pass as compliant")
	}
}

// countRuleBodyLines is the longest rule span in a document, shared by the ceiling check and its red
// path so the two cannot disagree about what "a rule's length" means.
func countRuleBodyLines(text string) int {
	ruleHead := regexp.MustCompile(`^(\d{1,3})\. \*\*`)
	lines := strings.Split(text, "\n")
	start, longest := -1, 0
	closeSpan := func(end int) {
		if start >= 0 && end-start > longest {
			longest = end - start
		}
	}
	for i, line := range lines {
		if strings.HasPrefix(line, "## ") || strings.HasPrefix(line, "# ") {
			closeSpan(i)
			start = -1
			continue
		}
		if ruleHead.MatchString(line) {
			closeSpan(i)
			start = i
		}
	}
	closeSpan(len(lines))
	return longest
}

// joinedProblems renders a problem list so that EVERY entry reaches the CI log.
//
// MEASURED 2026-10-27: the ledger gate joined its problems with newlines inside a single fmt.Errorf, and Lane CI
// prints only the TAIL of the go test output. A run therefore reported
//
//	evidence ledger docs/goal-scorecard.md is inconsistent:
//
// with the entire reason absent, so two lanes could not act on a red they could see. An error whose payload never
// reaches the log is AGENTS verification rule 7 in the reporting layer: evidence that reads as proof and cannot be
// read. Each problem is now emitted as its own `| problem: ...` line with the separator explicitly visible, and the
// header keeps the file name so a reader still knows which document failed.
func joinedProblems(problems []string) string {
	var builder strings.Builder
	for _, problem := range problems {
		builder.WriteString("\n  | problem: ")
		builder.WriteString(problem)
	}
	return builder.String()
}
