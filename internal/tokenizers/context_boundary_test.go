package tokenizers

// Context-boundary properties, from AGENTS.md rule 9.
//
// Three properties matter here, and only two of them are GoTavern server behaviour:
//
//  1. TAIL STABILITY (server behaviour). Appending text may change the tokens of the final
//     piece, but it must not change the tokens before it, and the count must never decrease.
//     A client that trims by token index relies on this; a violation means two clients that
//     trim the same history by count and by index disagree about what fits.
//
//  2. SAME COUNT, DIFFERENT TOKENS (server behaviour). Two texts can have the same count and
//     completely different tokens. That is why an assertion of the form "the count is N" does
//     not prove the boundary: it would pass with the right number for the wrong tokens. The
//     cases below are taken from the pinned capture, so the property is oracle evidence rather
//     than an argument.
//
//  3. NOT A LAW OF BPE: THE RE-MERGE COUNTER-PROPERTY. Tail stability is not a universal law.
//     Appending a suffix can re-merge the last token of the base text, so ids(A) is not always
//     a prefix of ids(A+suffix). The tests below therefore assert the full prefix where it holds
//     and assert the re-merge explicitly where it does not, instead of asserting a universal
//     prefix that the engines do not guarantee.
//
// WHAT IS NOT HERE: the "off-by-one changes the provider request" property. GoTavern's server
// only counts; the pinned frontend trims history client-side before it posts. There is no
// server-side trimmer in this repository, so that property is measured by the browser E2E
// harness, which does not exist yet, and it is recorded as a named gap in
// docs/tokenizer-parity-plan.md §9.1. No test in this file claims GoTavern trimming behaviour.

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// boundaryEngine adapts the three engines to one shape for the invariant tests.
// wantBoundaryReMergeEngines is the measured number of engines for which at least one candidate
// Measured: 11 of 11 engines for the current candidate list; the floor is deliberately lower
// re-merges the final piece. The assertion is a floor rather than a fixed set, so adding an
// engine or a candidate cannot break it, while losing the counter-property altogether does.
const wantBoundaryReMergeEngines = 6

type boundaryEngine struct {
	name   string
	encode func(string) ([]int, error)
}

func boundaryEngines(t *testing.T) []boundaryEngine {
	t.Helper()
	engines := []boundaryEngine{}

	loaded, err := OpenTiktokenSet(filepath.Join(hfDataPath, "tiktoken"))
	if err != nil {
		t.Fatal(err)
	}
	encoding, err := loaded.Encoding("gpt2")
	if err != nil {
		t.Fatal(err)
	}
	engines = append(engines, boundaryEngine{name: "gpt2", encode: encoding.Encode})

	for _, model := range hfModels {
		processors := openHFSet(t)
		processor := processors[model]
		engines = append(engines, boundaryEngine{name: model, encode: processor.Encode})
	}
	for _, model := range []string{"llama", "nerdstash", "mistral"} {
		processor, err := OpenSentencePiece(filepath.Join(hfDataPath, model+".model"))
		if err != nil {
			t.Fatal(err)
		}
		engines = append(engines, boundaryEngine{name: model, encode: func(text string) ([]int, error) {
			ids, _ := processor.Encode(text)
			return ids, nil
		}})
	}
	return engines
}

// TestContextBoundaryTailStability asserts the properties a trimming client depends on:
// appending text never decreases the count, and it never changes the tokens before the final
// piece. It also asserts the counter-property explicitly, so the suite cannot be read as
// claiming a universal prefix law.
func TestContextBoundaryTailStability(t *testing.T) {
	// Each pair appends a suffix that adds at least one token for every engine under test.
	pairs := []struct{ base, suffix string }{
		{"Hello", ", world"},
		{"The quick brown fox", " jumps"},
		{"a\nb", "\nc"},
		{"x", "y"},
		{"abc", " def ghi"},
		{"Всё хорошо", " и"},
	}
	// This pair re-merges the final token of the base text for at least one engine: "Hell"
	// is not a stable prefix of "Hello" once the final piece is re-tokenized. The test asserts
	// the re-merge rather than forbidding it.
	// Candidates likely to re-merge the final token: appending a character to a word that is
	// already split changes that word's last token without touching anything before it.
	reMergeCandidates := []struct{ base, suffix string }{
		{"The quick brown", "x"},
		{"Hello, world", "!"},
		{"test", "ing"},
		{"abc", "d"},
		{"???", "x"},
		{"Hell", "o"},
	}
	reMergeObserved := 0
	for _, engine := range boundaryEngines(t) {
		for _, pair := range pairs {
			baseIDs, err := engine.encode(pair.base)
			if err != nil {
				t.Fatalf("%s/%q: %v", engine.name, pair.base, err)
			}
			joinedIDs, err := engine.encode(pair.base + pair.suffix)
			if err != nil {
				t.Fatalf("%s/%q: %v", engine.name, pair.base+pair.suffix, err)
			}
			if len(joinedIDs) < len(baseIDs) {
				t.Fatalf("%s/%q: appending %q decreased the count from %d to %d", engine.name, pair.base, pair.suffix, len(baseIDs), len(joinedIDs))
			}
			stableCount := len(baseIDs) - 1
			if stableCount <= 0 {
				continue
			}
			stable := baseIDs[:stableCount]
			if len(joinedIDs) < len(stable) {
				t.Fatalf("%s/%q: the joined text has %d ids, fewer than the %d stable ids", engine.name, pair.base, len(joinedIDs), len(stable))
			}
			for index := range stable {
				if joinedIDs[index] != stable[index] {
					t.Fatalf("%s/%q: appending %q changed id %d from %d to %d; only the final piece may change",
						engine.name, pair.base, pair.suffix, index, stable[index], joinedIDs[index])
				}
			}
		}

		// The counter-property: appending a suffix may re-merge the final token of the base
		// text, so ids(base) is not always a prefix. The candidates below are searched rather
		// than assumed, and the guard at the end fails if none of them re-merges, so this
		// cannot pass vacuously if an engine's behaviour changes.
		for _, candidate := range reMergeCandidates {
			baseIDs, err := engine.encode(candidate.base)
			if err != nil {
				t.Fatal(err)
			}
			joinedIDs, err := engine.encode(candidate.base + candidate.suffix)
			if err != nil {
				t.Fatal(err)
			}
			if len(baseIDs) == 0 || len(joinedIDs) == 0 {
				continue
			}
			isFullPrefix := true
			compareCount := len(baseIDs)
			if len(joinedIDs) < compareCount {
				compareCount = len(joinedIDs)
			}
			for index := 0; index < compareCount; index++ {
				if joinedIDs[index] != baseIDs[index] {
					isFullPrefix = false
					break
				}
			}
			if isFullPrefix {
				continue
			}
			reMergeObserved++
			// The real law: a re-merge is confined to the final piece.
			for index := 0; index < len(baseIDs)-1; index++ {
				if joinedIDs[index] != baseIDs[index] {
					t.Fatalf("%s/%q+%q: the re-merge changed id %d, before the final piece", engine.name, candidate.base, candidate.suffix, index)
				}
			}
			t.Logf("%s: appending %q to %q re-merged the final token (%d -> %d ids), so the full-prefix law does not hold there",
				engine.name, candidate.suffix, candidate.base, len(baseIDs), len(joinedIDs))
			break
		}
	}
	if reMergeObserved < wantBoundaryReMergeEngines {
		t.Fatalf("only %d engines re-merged the final piece, want at least %d: the counter-property is a single point of failure", reMergeObserved, wantBoundaryReMergeEngines)
	}
	t.Logf("re-merge observed for %d engines; the full-prefix law is not universal", reMergeObserved)
}

// TestContextBoundarySameCountDifferentTokens pins property 2 from the pinned capture: for
// every engine family, two recorded inputs with the SAME count produce different ids and
// different chunks. If the engine ever returned the right count for the wrong tokens, the
// reproduction assertions below fail even though a count-only test would still pass.
func TestContextBoundarySameCountDifferentTokens(t *testing.T) {
	fixture := loadOracle(t)
	processors := openHFSet(t)
	sentencePieces := map[string]*SentencePiece{}
	for _, model := range tokenizerSentencePieceModelNames() {
		processor, err := OpenSentencePiece(filepath.Join(hfDataPath, model+".model"))
		if err != nil {
			t.Fatal(err)
		}
		sentencePieces[model] = processor
	}
	loaded, err := OpenTiktokenSet(filepath.Join(hfDataPath, "tiktoken"))
	if err != nil {
		t.Fatal(err)
	}

	type captured struct {
		text   string
		ids    []int
		chunks []string
		count  int
	}
	read := func(name string) captured {
		t.Helper()
		capture, ok := fixture.Responses[name]
		if !ok {
			t.Fatalf("required boundary case %q is missing from the fixture", name)
		}
		var body struct {
			IDs    []int    `json:"ids"`
			Count  int      `json:"count"`
			Chunks []string `json:"chunks"`
		}
		if err := json.Unmarshal(capture.Body, &body); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return captured{text: requestText(t, name, capture.Request.Body), ids: body.IDs, chunks: body.Chunks, count: body.Count}
	}

	// One pair per family, each taken from the capture: same count, different ids, different
	// chunks.
	pairs := []struct{ model, left, right string }{
		{"gpt2", "gpt2/encode#low_surrogate", "gpt2/encode#one_char"},
		{"llama", "llama/encode#only_spaces", "llama/encode#one_char"},
		{"nerdstash", "nerdstash/encode#one_char", "nerdstash/encode#space"},
		{"claude", "claude/encode#only_spaces", "claude/encode#one_char"},
		{"llama3", "llama3/encode#cjk", "llama3/encode#trailing_spaces"},
		{"qwen2", "qwen2/encode#cjk", "qwen2/encode#emoji"},
		{"nemo", "nemo/encode#cjk", "nemo/encode#trailing_spaces"},
		{"deepseek", "deepseek/encode#trailing_spaces", "deepseek/encode#compat_ligature"},
	}
	for _, pair := range pairs {
		left := read(pair.left)
		right := read(pair.right)
		if left.count != right.count {
			t.Fatalf("%s: %q counts %d and %q counts %d; the pair is no longer an equal-count pair, so it no longer proves anything",
				pair.model, pair.left, left.count, pair.right, right.count)
		}
		if equalIntSlices(left.ids, right.ids) {
			t.Fatalf("%s: %q and %q have the same ids %v; the pair no longer distinguishes count from tokens", pair.model, pair.left, pair.right, left.ids)
		}
		if equalStrings(left.chunks, right.chunks) {
			t.Fatalf("%s: %q and %q have the same chunks %q", pair.model, pair.left, pair.right, left.chunks)
		}

		// The engine must reproduce both sides, so the pair is evidence for this engine and not
		// only a property of the recording.
		var gotLeft, gotRight []int
		if processor, ok := processors[pair.model]; ok {
			gotLeft, err = processor.Encode(left.text)
			if err != nil {
				t.Fatal(err)
			}
			gotRight, err = processor.Encode(right.text)
			if err != nil {
				t.Fatal(err)
			}
		} else if processor, ok := sentencePieces[pair.model]; ok {
			gotLeft, _ = processor.Encode(left.text)
			gotRight, _ = processor.Encode(right.text)
		} else {
			encoding, err := loaded.Encoding(pair.model)
			if err != nil {
				t.Fatal(err)
			}
			gotLeft, err = encoding.Encode(left.text)
			if err != nil {
				t.Fatal(err)
			}
			gotRight, err = encoding.Encode(right.text)
			if err != nil {
				t.Fatal(err)
			}
		}
		if !equalIntSlices(gotLeft, left.ids) || !equalIntSlices(gotRight, right.ids) {
			t.Fatalf("%s: %q produced %v (pinned %v) and %q produced %v (pinned %v)",
				pair.model, pair.left, gotLeft, left.ids, pair.right, gotRight, right.ids)
		}
	}
}

// tokenizerSentencePieceModelNames lists the SentencePiece models the capture covers.
func tokenizerSentencePieceModelNames() []string {
	return []string{"llama", "nerdstash", "nerdstash_v2", "mistral", "yi", "gemma", "jamba"}
}
