package tokenizers

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/dlclark/regexp2"
	"golang.org/x/text/unicode/norm"
)

// HF is a pinned HuggingFace `tokenizer.json` processor, as used by the pinned
// @agnai/web-tokenizers wrapper.
//
// The engine reads the normalizer, pre-tokenizer, decoder and added-token list from the file
// and refuses any shape it does not implement, because the five externally fetched tokenizers
// come from a branch upstream does not pin (docs/tokenizer-parity-plan.md §10). Two things the
// file says are deliberately NOT implemented, because the pinned capture shows they do not
// happen: a TemplateProcessing post-processor is never applied (no BOS is inserted), and a
// `Sequence` normalizer with no normalizers is a no-op rather than an absent normalizer.
type HF struct {
	Name string

	vocab     map[string]int
	idToToken []string
	merges    map[string]int
	unkID     int

	addedTokens []hfAddedToken
	addedByByte map[byte][]hfAddedToken

	normalizer norm.Form
	// applyNormalizer is separate from the form because norm.NFC is norm.Form's zero value,
	// so the form alone cannot distinguish "NFC" from "no normalizer".
	applyNormalizer bool

	stages []hfStage
}

type hfAddedToken struct {
	Content string `json:"content"`
	ID      int    `json:"id"`
	Special bool   `json:"special"`
}

type hfStageKind int

const (
	hfByteLevel hfStageKind = iota
	hfDigits
	hfSplit
)

type hfStage struct {
	kind             hfStageKind
	useRegex         bool
	addPrefixSpace   bool
	individualDigits bool
	pattern          *regexp2.Regexp
}

// byteLevelPattern is the pattern the pinned HuggingFace tokenizers library hardcodes for a
// ByteLevel pre-tokenizer with use_regex. It belongs to the library version bundled in
// @agnai/web-tokenizers 0.1.3, not to the tokenizer file, so it is version-sensitive: a
// wrapper upgrade could change it.
var byteLevelRegex = regexp2.MustCompile(byteLevelPattern, regexp2.None)

const byteLevelPattern = `'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+`

type hfFile struct {
	Version     string          `json:"version"`
	AddedTokens []hfAddedToken  `json:"added_tokens"`
	Normalizer  json.RawMessage `json:"normalizer"`
	PreToken    json.RawMessage `json:"pre_tokenizer"`
	Decoder     json.RawMessage `json:"decoder"`
	Model       struct {
		Type                    string          `json:"type"`
		Vocab                   map[string]int  `json:"vocab"`
		Merges                  json.RawMessage `json:"merges"`
		UnkToken                *string         `json:"unk_token"`
		ByteFallback            bool            `json:"byte_fallback"`
		FuseUnk                 bool            `json:"fuse_unk"`
		ContinuingSubwordPrefix *string         `json:"continuing_subword_prefix"`
		EndOfWordSuffix         *string         `json:"end_of_word_suffix"`
	} `json:"model"`
}

// OpenHF loads and validates one pinned tokenizer.json.
func OpenHF(path string) (*HF, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseHF(filepathBase(path), raw)
}

// ParseHF validates one tokenizer.json from its bytes. The five externally fetched
// tokenizers are vendored gzipped, so callers holding the bytes (the tests, and the runtime
// once it has materialized the cache file) use this instead of a path.
func ParseHF(name string, raw []byte) (*HF, error) {
	path := name
	var file hfFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("tokenizers: %s: %w", path, err)
	}
	if file.Model.Type != "BPE" {
		return nil, fmt.Errorf("tokenizers: %s has model type %q, only BPE is implemented", path, file.Model.Type)
	}
	if file.Model.ByteFallback || file.Model.FuseUnk {
		return nil, fmt.Errorf("tokenizers: %s uses byte_fallback/fuse_unk, which is not implemented", path)
	}
	if prefix := file.Model.ContinuingSubwordPrefix; prefix != nil && *prefix != "" {
		return nil, fmt.Errorf("tokenizers: %s uses continuing_subword_prefix %q, which is not implemented", path, *prefix)
	}
	if suffix := file.Model.EndOfWordSuffix; suffix != nil && *suffix != "" {
		return nil, fmt.Errorf("tokenizers: %s uses end_of_word_suffix %q, which is not implemented", path, *suffix)
	}

	tokenizer := &HF{
		Name:        strings.TrimSuffix(name, ".json"),
		vocab:       file.Model.Vocab,
		unkID:       -1,
		addedByByte: map[byte][]hfAddedToken{},
	}
	if len(tokenizer.vocab) == 0 {
		return nil, fmt.Errorf("tokenizers: %s has an empty vocabulary", path)
	}
	tokenizer.idToToken = make([]string, 0, len(tokenizer.vocab))
	// assigned tracks which ids came from the vocabulary, because an empty token string is a
	// legitimate vocabulary entry (the pinned deepseek file has one) so "" cannot be a marker.
	assigned := make([]bool, 0, len(tokenizer.vocab))
	assign := func(id int, token string) error {
		for len(tokenizer.idToToken) <= id {
			tokenizer.idToToken = append(tokenizer.idToToken, "")
			assigned = append(assigned, false)
		}
		if assigned[id] {
			return fmt.Errorf("tokenizers: %s assigns id %d twice", path, id)
		}
		tokenizer.idToToken[id] = token
		assigned[id] = true
		return nil
	}
	for token, id := range tokenizer.vocab {
		if id < 0 {
			return nil, fmt.Errorf("tokenizers: %s has a negative id %d", path, id)
		}
		if err := assign(id, token); err != nil {
			return nil, err
		}
	}
	if file.Model.UnkToken != nil {
		id, ok := tokenizer.vocab[*file.Model.UnkToken]
		if !ok {
			return nil, fmt.Errorf("tokenizers: %s declares unk_token %q that is not in the vocabulary", path, *file.Model.UnkToken)
		}
		tokenizer.unkID = id
	}

	tokenizer.merges = map[string]int{}
	var mergeStrings []string
	if err := json.Unmarshal(file.Model.Merges, &mergeStrings); err != nil {
		var mergePairs [][2]string
		if err := json.Unmarshal(file.Model.Merges, &mergePairs); err != nil {
			return nil, fmt.Errorf("tokenizers: %s has an unsupported merges shape", path)
		}
		for _, pair := range mergePairs {
			mergeStrings = append(mergeStrings, pair[0]+" "+pair[1])
		}
	}
	for rank, merge := range mergeStrings {
		tokenizer.merges[merge] = rank
	}
	if len(tokenizer.merges) == 0 {
		return nil, fmt.Errorf("tokenizers: %s has no merges", path)
	}

	form, apply, err := hfNormalizer(path, file.Normalizer)
	if err != nil {
		return nil, err
	}
	tokenizer.normalizer = form
	tokenizer.applyNormalizer = apply
	stages, err := hfStages(path, file.PreToken)
	if err != nil {
		return nil, err
	}
	tokenizer.stages = stages
	if err := hfDecoderShape(path, file.Decoder); err != nil {
		return nil, err
	}

	// Added tokens carry their own ids, which are usually above the mergeable vocabulary
	// (llama3's start at 128000), so they extend the id table rather than being validated
	// against it. An added token that collides with a different vocabulary entry is refused.
	for _, added := range file.AddedTokens {
		if added.ID < 0 {
			return nil, fmt.Errorf("tokenizers: %s added token %q has a negative id", path, added.Content)
		}
		for len(tokenizer.idToToken) <= added.ID {
			tokenizer.idToToken = append(tokenizer.idToToken, "")
			assigned = append(assigned, false)
		}
		if assigned[added.ID] && tokenizer.idToToken[added.ID] != added.Content {
			return nil, fmt.Errorf("tokenizers: %s added token %q collides with %q at id %d", path, added.Content, tokenizer.idToToken[added.ID], added.ID)
		}
		tokenizer.idToToken[added.ID] = added.Content
		assigned[added.ID] = true
		tokenizer.addedTokens = append(tokenizer.addedTokens, added)
	}
	sort.Slice(tokenizer.addedTokens, func(left, right int) bool {
		return len(tokenizer.addedTokens[left].Content) > len(tokenizer.addedTokens[right].Content)
	})
	for _, added := range tokenizer.addedTokens {
		if added.Content == "" {
			continue
		}
		tokenizer.addedByByte[added.Content[0]] = append(tokenizer.addedByByte[added.Content[0]], added)
	}
	return tokenizer, nil
}

// hfNormalizer maps the file's normalizer to a Unicode form. An absent normalizer and a
// Sequence with no normalizers are both no-ops; the pinned deepseek file uses the latter.
func hfNormalizer(path string, raw json.RawMessage) (norm.Form, bool, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, false, nil
	}
	var shape struct {
		Type        string            `json:"type"`
		Normalizers []json.RawMessage `json:"normalizers"`
	}
	if err := json.Unmarshal(raw, &shape); err != nil {
		return 0, false, fmt.Errorf("tokenizers: %s has an unparseable normalizer: %w", path, err)
	}
	switch shape.Type {
	case "NFC":
		return norm.NFC, true, nil
	case "NFKC":
		return norm.NFKC, true, nil
	case "Sequence":
		if len(shape.Normalizers) != 0 {
			return 0, false, fmt.Errorf("tokenizers: %s has a Sequence normalizer with %d members, which is not implemented", path, len(shape.Normalizers))
		}
		return 0, false, nil
	default:
		return 0, false, fmt.Errorf("tokenizers: %s has normalizer type %q, which is not implemented", path, shape.Type)
	}
}

// hfStages parses the pre-tokenizer pipeline.
func hfStages(path string, raw json.RawMessage) ([]hfStage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var shape struct {
		Type          string            `json:"type"`
		Pretokenizers []json.RawMessage `json:"pretokenizers"`
		AddPrefix     bool              `json:"add_prefix_space"`
		UseRegex      *bool             `json:"use_regex"`
		Individual    bool              `json:"individual_digits"`
		Pattern       struct {
			Regex string `json:"Regex"`
		} `json:"pattern"`
		Behavior string `json:"behavior"`
		Invert   bool   `json:"invert"`
	}
	if err := json.Unmarshal(raw, &shape); err != nil {
		return nil, fmt.Errorf("tokenizers: %s has an unparseable pre_tokenizer: %w", path, err)
	}
	var stages []hfStage
	appendStage := func(stage hfStage) { stages = append(stages, stage) }
	build := func(rawStage json.RawMessage) error {
		var item struct {
			Type       string `json:"type"`
			AddPrefix  bool   `json:"add_prefix_space"`
			UseRegex   *bool  `json:"use_regex"`
			Individual bool   `json:"individual_digits"`
			Pattern    struct {
				Regex string `json:"Regex"`
			} `json:"pattern"`
			Behavior string `json:"behavior"`
			Invert   bool   `json:"invert"`
		}
		if err := json.Unmarshal(rawStage, &item); err != nil {
			return fmt.Errorf("tokenizers: %s has an unparseable pre_tokenizer member: %w", path, err)
		}
		switch item.Type {
		case "ByteLevel":
			useRegex := true // the HuggingFace default
			if item.UseRegex != nil {
				useRegex = *item.UseRegex
			}
			appendStage(hfStage{kind: hfByteLevel, useRegex: useRegex, addPrefixSpace: item.AddPrefix})
		case "Digits":
			appendStage(hfStage{kind: hfDigits, individualDigits: item.Individual})
		case "Split":
			if item.Behavior != "Isolated" || item.Invert {
				return fmt.Errorf("tokenizers: %s has a Split pre_tokenizer with behavior %q invert=%v, which is not implemented", path, item.Behavior, item.Invert)
			}
			pattern, err := regexp2.Compile(item.Pattern.Regex, regexp2.None)
			if err != nil {
				return fmt.Errorf("tokenizers: %s Split pattern does not compile: %w", path, err)
			}
			appendStage(hfStage{kind: hfSplit, pattern: pattern})
		default:
			return fmt.Errorf("tokenizers: %s has pre_tokenizer type %q, which is not implemented", path, item.Type)
		}
		return nil
	}
	if shape.Type == "Sequence" {
		for _, member := range shape.Pretokenizers {
			if err := build(member); err != nil {
				return nil, err
			}
		}
		return stages, nil
	}
	if err := build(raw); err != nil {
		return nil, err
	}
	return stages, nil
}

// hfDecoderShape accepts the ByteLevel decoder and nothing else. The decoder's
// add_prefix_space/trim_offsets fields do not affect decoding.
func hfDecoderShape(path string, raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var shape struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &shape); err != nil {
		return fmt.Errorf("tokenizers: %s has an unparseable decoder: %w", path, err)
	}
	if shape.Type != "ByteLevel" {
		return fmt.Errorf("tokenizers: %s has decoder type %q, which is not implemented", path, shape.Type)
	}
	return nil
}

// Encode tokenizes text the way the pinned wrapper does. A post-processor is never applied,
// so no BOS is inserted even where the file declares one.
func (h *HF) Encode(text string) ([]int, error) {
	// The pinned wrapper tokenizes an unpaired surrogate as its WTF-8 bytes (three separate
	// byte tokens, unmerged), unlike the tiktoken WASM which substitutes U+FFFD. The
	// pre-tokenizer patterns are rune-based, so those bytes are escaped to private-use runes
	// first and mapped back by encodeByteLevel; without that a Split pattern would turn them
	// into U+FFFD and produce a different token count.
	normalized := escapeSurrogateBytes(text)
	if h.applyNormalizer {
		normalized = h.normalizer.String(normalized)
	}
	ids := []int{}
	for _, segment := range h.splitAddedTokens(normalized) {
		if segment.addedID >= 0 {
			ids = append(ids, segment.addedID)
			continue
		}
		for _, word := range h.preTokenize(segment.text) {
			ids = append(ids, h.bpeWord(word)...)
		}
	}
	return ids, nil
}

type hfSegment struct {
	text    string
	addedID int
}

// splitAddedTokens splits normalized text into added-token and plain segments, taking the
// longest added token at each position, which is how the pinned added vocabulary behaves.
func (h *HF) splitAddedTokens(text string) []hfSegment {
	if len(h.addedTokens) == 0 {
		return []hfSegment{{text: text, addedID: -1}}
	}
	segments := []hfSegment{}
	plainStart := 0
	for index := 0; index < len(text); {
		matched := -1
		matchedLength := 0
		for _, candidate := range h.addedByByte[text[index]] {
			if len(candidate.Content) > matchedLength && strings.HasPrefix(text[index:], candidate.Content) {
				matched = candidate.ID
				matchedLength = len(candidate.Content)
			}
		}
		if matched < 0 {
			index++
			continue
		}
		if index > plainStart {
			segments = append(segments, hfSegment{text: text[plainStart:index], addedID: -1})
		}
		segments = append(segments, hfSegment{text: text[index : index+matchedLength], addedID: matched})
		index += matchedLength
		plainStart = index
	}
	if plainStart < len(text) {
		segments = append(segments, hfSegment{text: text[plainStart:], addedID: -1})
	}
	return segments
}

// preTokenize runs the pre-tokenizer pipeline and returns byte-level words.
func (h *HF) preTokenize(text string) []string {
	pieces := []string{text}
	for _, stage := range h.stages {
		next := make([]string, 0, len(pieces))
		for _, piece := range pieces {
			if piece == "" {
				continue
			}
			switch stage.kind {
			case hfSplit:
				next = append(next, splitIsolated(piece, stage.pattern)...)
			case hfDigits:
				next = append(next, splitDigits(piece, stage.individualDigits)...)
			case hfByteLevel:
				next = append(next, byteLevelWords(piece, stage)...)
			}
		}
		pieces = next
	}
	return pieces
}

// splitIsolated splits text at every pattern match, keeping each match as its own piece.
// regexp2 reports rune offsets, so the text is sliced as runes rather than bytes.
func splitIsolated(text string, pattern *regexp2.Regexp) []string {
	runes := []rune(text)
	pieces := []string{}
	position := 0
	match, err := pattern.FindStringMatch(text)
	for err == nil && match != nil {
		start := match.Index
		end := start + match.Length
		if start > position {
			pieces = append(pieces, string(runes[position:start]))
		}
		pieces = append(pieces, string(runes[start:end]))
		position = end
		match, err = pattern.FindNextMatch(match)
	}
	if position < len(runes) {
		pieces = append(pieces, string(runes[position:]))
	}
	return pieces
}

// splitDigits isolates digit characters when the pre-tokenizer asks for it.
func splitDigits(text string, individual bool) []string {
	if !individual {
		return []string{text}
	}
	pieces := []string{}
	start := 0
	inDigit := false
	for index, r := range text {
		isDigit := r >= '0' && r <= '9'
		if index == 0 {
			inDigit = isDigit
			continue
		}
		if isDigit != inDigit {
			pieces = append(pieces, text[start:index])
			start = index
			inDigit = isDigit
		}
	}
	pieces = append(pieces, text[start:])
	return pieces
}

// byteLevelWords applies the ByteLevel pre-tokenizer: optionally split with the library's
// pattern, then map every byte through the byte-to-unicode alphabet.
func byteLevelWords(piece string, stage hfStage) []string {
	words := []string{}
	if stage.addPrefixSpace {
		piece = " " + piece
	}
	if !stage.useRegex {
		return []string{encodeByteLevel(piece)}
	}
	match, err := byteLevelRegex.FindStringMatch(piece)
	for err == nil && match != nil {
		words = append(words, encodeByteLevel(match.String()))
		match, err = byteLevelRegex.FindNextMatch(match)
	}
	return words
}

// bpeWord applies byte-pair encoding to one byte-level word: repeatedly merge the adjacent
// pair with the lowest merge rank.
func (h *HF) bpeWord(word string) []int {
	symbols := make([]string, 0, len(word))
	for _, r := range word {
		symbols = append(symbols, string(r))
	}
	for len(symbols) > 1 {
		bestRank := len(h.merges)
		bestIndex := -1
		for index := 0; index+1 < len(symbols); index++ {
			rank, ok := h.merges[symbols[index]+" "+symbols[index+1]]
			if ok && rank < bestRank {
				bestRank = rank
				bestIndex = index
			}
		}
		if bestIndex < 0 {
			break
		}
		symbols[bestIndex] = symbols[bestIndex] + symbols[bestIndex+1]
		symbols = append(symbols[:bestIndex+1], symbols[bestIndex+2:]...)
	}
	ids := make([]int, 0, len(symbols))
	for _, symbol := range symbols {
		if id, ok := h.vocab[symbol]; ok {
			ids = append(ids, id)
			continue
		}
		// The pinned files declare no unk_token, so an unknown symbol is dropped.
		if h.unkID >= 0 {
			ids = append(ids, h.unkID)
		}
	}
	return ids
}

// DecodeIDs decodes a sequence of ids: every token's characters are mapped back through the
// alphabet and the bytes are decoded lossily, which is the HuggingFace ByteLevel decoder.
// Special and added tokens are NOT skipped, and an out-of-range id makes the call return the
// empty string rather than an error, exactly as the pinned wrapper does.
func (h *HF) DecodeIDs(ids []int) (string, error) {
	decoded := make([]byte, 0, len(ids)*4)
	for _, id := range ids {
		if id < 0 || id >= len(h.idToToken) {
			return "", nil
		}
		for _, r := range h.idToToken[id] {
			if b, ok := byteLevelReverse[r]; ok {
				decoded = append(decoded, b)
				continue
			}
			decoded = append(decoded, []byte(string(r))...)
		}
	}
	return ReplaceInvalidUTF8(decoded), nil
}

// DecodeSingle decodes one id, which is what the pinned decode route does per id.
func (h *HF) DecodeSingle(id int) string {
	text, _ := h.DecodeIDs([]int{id})
	return text
}

// Chunks reproduces getWebTokenizersChunks: decode growing id slices and skip a slice that
// decodes to a lone replacement character.
func (h *HF) Chunks(ids []int) ([]string, error) {
	chunks := []string{}
	lastProcessed := 0
	for index := 0; index < len(ids); index++ {
		text, err := h.DecodeIDs(ids[lastProcessed : index+1])
		if err != nil {
			return nil, err
		}
		if text == "\uFFFD" {
			continue
		}
		chunks = append(chunks, text)
		lastProcessed = index + 1
	}
	return chunks, nil
}

// CountArrayTokens reproduces countWebTokenizerTokens: the values of every message are
// flattened and joined with a blank line, then tokenized as one string.
func (h *HF) CountArrayTokens(messages []Message) int {
	values := make([]string, 0, len(messages))
	for _, message := range messages {
		for _, entry := range message {
			values = append(values, stringifyValue(entry.Value))
		}
	}
	ids, _ := h.Encode(strings.Join(values, "\n\n"))
	return len(ids)
}
