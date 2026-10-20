// Package tokenizers implements the pinned SillyTavern tokenizer backends in pure Go.
//
// The tokenizer data is a release asset under upstream/tokenizers/**, not an embedded
// tree, and every behaviour in this package is measured against the pinned Node capture
// in tests/oracle/sillytavern-1.19.0-tokenizers.json rather than against a reading of the
// upstream source.
package tokenizers

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/pkoukk/tiktoken-go"
)

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}

// tiktokenSegmentMarker introduces one segment of a vendored rank table. A segment is
// "<marker> <startRank> <base64 token>...", and its tokens take consecutive ranks from
// startRank. Tables that skip a rank (p50k_base and p50k_edit leave 50256 to
// <|endoftext|>) carry a second segment starting at the next rank, so a parser that
// assumes one implicit sequence gets every rank in that family wrong.
const tiktokenSegmentMarker = "!"

// tiktokenFile is the on-disk shape of upstream/tokenizers/tiktoken/<encoding>.json.
type tiktokenFile struct {
	PatStr        string         `json:"pat_str"`
	SpecialTokens map[string]int `json:"special_tokens"`
	BpeRanks      string         `json:"bpe_ranks"`
}

// Tiktoken is one pinned tiktoken encoding. It is immutable after loading and safe for
// concurrent use.
type Tiktoken struct {
	Name         string
	pattern      string
	encoder      map[string]int
	decoder      map[int]string
	specials     map[string]int
	specialOrder []string
	inner        *tiktoken.Tiktoken
}

// TiktokenSet loads encodings lazily from a directory and caches them per process,
// mirroring the pinned tokenizersCache.
type TiktokenSet struct {
	dir       string
	models    map[string]string
	encodings map[string]*Tiktoken
}

// OpenTiktokenSet reads the pinned model -> encoding table. Encodings themselves are
// loaded on first use.
func OpenTiktokenSet(dir string) (*TiktokenSet, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "model_to_encoding.json"))
	if err != nil {
		return nil, err
	}
	var models map[string]string
	if err := json.Unmarshal(raw, &models); err != nil {
		return nil, fmt.Errorf("tokenizers: model_to_encoding.json: %w", err)
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("tokenizers: model_to_encoding.json is empty")
	}
	return &TiktokenSet{dir: dir, models: models, encodings: map[string]*Tiktoken{}}, nil
}

// EncodingForModel mirrors pinned tiktoken's encoding_for_model: an exact lookup that
// fails for any other name. Pinned tiktoken does not prefix-match, so neither does this.
func (s *TiktokenSet) EncodingForModel(model string) (string, bool) {
	name, ok := s.models[model]
	return name, ok
}

// ForModel resolves a model name to its encoding.
func (s *TiktokenSet) ForModel(model string) (*Tiktoken, error) {
	name, ok := s.EncodingForModel(model)
	if !ok {
		return nil, fmt.Errorf("tokenizers: no tiktoken encoding for model %q", model)
	}
	return s.Encoding(name)
}

// Encoding loads and caches one encoding by name.
func (s *TiktokenSet) Encoding(name string) (*Tiktoken, error) {
	if cached, ok := s.encodings[name]; ok {
		return cached, nil
	}
	loaded, err := loadTiktoken(s.dir, name)
	if err != nil {
		return nil, err
	}
	s.encodings[name] = loaded
	return loaded, nil
}

func loadTiktoken(dir, name string) (*Tiktoken, error) {
	path := filepath.Join(dir, name+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var file tiktokenFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("tokenizers: %s: %w", path, err)
	}
	if file.PatStr == "" {
		return nil, fmt.Errorf("tokenizers: %s has no pat_str", path)
	}
	encoder := make(map[string]int, 1<<17)
	decoder := make(map[int]string, 1<<17)
	segments := 0
	for _, segment := range strings.Split(file.BpeRanks, "\n") {
		fields := strings.Fields(segment)
		if len(fields) == 0 {
			continue
		}
		if len(fields) < 3 || fields[0] != tiktokenSegmentMarker {
			return nil, fmt.Errorf("tokenizers: %s has an unrecognized rank segment %q", path, truncate(segment, 32))
		}
		startRank, err := strconv.Atoi(fields[1])
		if err != nil {
			return nil, fmt.Errorf("tokenizers: %s segment start rank %q is not a number", path, fields[1])
		}
		for offset, field := range fields[2:] {
			rank := startRank + offset
			piece, err := base64.StdEncoding.DecodeString(field)
			if err != nil {
				return nil, fmt.Errorf("tokenizers: %s rank %d is not base64: %w", path, rank, err)
			}
			token := string(piece)
			if _, duplicate := encoder[token]; duplicate {
				return nil, fmt.Errorf("tokenizers: %s rank %d duplicates a token", path, rank)
			}
			if _, duplicate := decoder[rank]; duplicate {
				return nil, fmt.Errorf("tokenizers: %s rank %d is assigned twice", path, rank)
			}
			encoder[token] = rank
			decoder[rank] = token
		}
		segments++
	}
	if segments == 0 {
		return nil, fmt.Errorf("tokenizers: %s has no rank segments", path)
	}
	specialOrder := make([]string, 0, len(file.SpecialTokens))
	for token, id := range file.SpecialTokens {
		if _, duplicate := decoder[id]; duplicate {
			return nil, fmt.Errorf("tokenizers: %s special token %q collides with rank %d", path, token, id)
		}
		decoder[id] = token
		specialOrder = append(specialOrder, token)
	}
	sort.Strings(specialOrder)

	bpe, err := tiktoken.NewCoreBPE(encoder, file.SpecialTokens, file.PatStr)
	if err != nil {
		return nil, fmt.Errorf("tokenizers: %s: %w", path, err)
	}
	inner := tiktoken.NewTiktoken(bpe, &tiktoken.Encoding{
		Name:           name,
		PatStr:         file.PatStr,
		MergeableRanks: encoder,
		SpecialTokens:  file.SpecialTokens,
	}, map[string]any{})

	return &Tiktoken{
		Name:         name,
		pattern:      file.PatStr,
		encoder:      encoder,
		decoder:      decoder,
		specials:     file.SpecialTokens,
		specialOrder: specialOrder,
		inner:        inner,
	}, nil
}

// Encode tokenizes text the way the pinned route does. Pinned tiktoken is called with no
// allowed special tokens and disallowedSpecial "all", so a text that contains any special
// token is an error rather than ordinary text. An unpaired surrogate reaches this point as
// WTF-8 and is converted the way the pinned WASM converts it at the JS boundary.
func (t *Tiktoken) Encode(text string) ([]int, error) {
	text = ReplaceWTFSurrogatesForTiktoken(text)
	if special, ok := t.disallowedSpecial(text); ok {
		return nil, fmt.Errorf("the text contains a special token that is not allowed: %s", special)
	}
	return t.inner.EncodeOrdinary(text), nil
}

// Decode mirrors pinned tiktoken's decode: the token bytes are concatenated and then
// decoded with replacement, and an id that is in neither the rank table nor the special
// table is an error (pinned tiktoken throws).
func (t *Tiktoken) Decode(ids []int) (string, error) {
	pieces := make([]byte, 0, len(ids)*2)
	for _, id := range ids {
		piece, ok := t.decoder[id]
		if !ok {
			return "", fmt.Errorf("tokenizers: %s has no token with id %d", t.Name, id)
		}
		pieces = append(pieces, piece...)
	}
	return ReplaceInvalidUTF8(pieces), nil
}

// Chunks mirrors the pinned per-token chunk list: each id is decoded on its own through a
// non-fatal decoder, so a token that carries a partial UTF-8 sequence becomes U+FFFD.
func (t *Tiktoken) Chunks(ids []int) ([]string, error) {
	chunks := make([]string, 0, len(ids))
	for _, id := range ids {
		piece, ok := t.decoder[id]
		if !ok {
			return nil, fmt.Errorf("tokenizers: %s has no token with id %d", t.Name, id)
		}
		chunks = append(chunks, ReplaceInvalidUTF8([]byte(piece)))
	}
	return chunks, nil
}

// SpecialTokens returns the encoding's special tokens.
func (t *Tiktoken) SpecialTokens() map[string]int {
	copied := make(map[string]int, len(t.specials))
	for token, id := range t.specials {
		copied[token] = id
	}
	return copied
}

func (t *Tiktoken) disallowedSpecial(text string) (string, bool) {
	for _, token := range t.specialOrder {
		if strings.Contains(text, token) {
			return token, true
		}
	}
	return "", false
}
