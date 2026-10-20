package tokenizers

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"unicode/utf8"
)

// SentencePiece is a pinned SentencePiece BPE processor.
//
// The seven models the pinned server ships are all model_type=BPE with byte_fallback,
// an "identity" normalizer whose precompiled charsmap is empty, and remove_extra_whitespaces
// off, so this file implements exactly that subset and refuses anything else rather than
// silently approximating it.
type SentencePiece struct {
	Name string

	pieces     []spPiece
	pieceToID  map[string]int
	byteToID   map[byte]int
	idToByte   map[int]byte
	unkID      int
	unkSurface string

	userDefined map[string]bool
	firstRune   map[rune][]string

	byteFallback           bool
	addDummyPrefix         bool
	escapeWhitespaces      bool
	removeExtraWhitespaces bool
	maxPieceLength         int
}

type spPieceKind int

const (
	spNormal      spPieceKind = 1
	spUnknown     spPieceKind = 2
	spControl     spPieceKind = 3
	spUserDefined spPieceKind = 4
	spUnused      spPieceKind = 5
	spByte        spPieceKind = 6
)

type spPiece struct {
	text  string
	score float32
	kind  spPieceKind
}

// OpenSentencePiece loads and validates one pinned .model file.
func OpenSentencePiece(path string) (*SentencePiece, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	model, err := parseSentencePieceModel(raw)
	if err != nil {
		return nil, fmt.Errorf("tokenizers: %s: %w", path, err)
	}
	if model.modelType != 2 {
		return nil, fmt.Errorf("tokenizers: %s is model type %d, only BPE is implemented", path, model.modelType)
	}
	if len(model.normalizerCharsmap) != 0 {
		return nil, fmt.Errorf("tokenizers: %s has a %d byte charsmap, which is not implemented", path, len(model.normalizerCharsmap))
	}
	processor := &SentencePiece{
		Name:                   strings.TrimSuffix(filepathBase(path), ".model"),
		pieceToID:              make(map[string]int, len(model.pieces)),
		byteToID:               make(map[byte]int, 256),
		idToByte:               make(map[int]byte, 256),
		unkID:                  -1,
		unkSurface:             model.unkSurface,
		userDefined:            map[string]bool{},
		firstRune:              map[rune][]string{},
		byteFallback:           model.byteFallback,
		addDummyPrefix:         model.addDummyPrefix,
		escapeWhitespaces:      model.escapeWhitespaces,
		removeExtraWhitespaces: model.removeExtraWhitespaces,
	}
	processor.pieces = model.pieces
	for id, piece := range model.pieces {
		switch piece.kind {
		case spNormal, spUserDefined, spUnused:
			if _, duplicate := processor.pieceToID[piece.text]; !duplicate {
				processor.pieceToID[piece.text] = id
			}
			if len(piece.text) > processor.maxPieceLength {
				processor.maxPieceLength = len(piece.text)
			}
			if piece.kind == spUserDefined {
				processor.userDefined[piece.text] = true
				first, _ := utf8.DecodeRuneInString(piece.text)
				processor.firstRune[first] = append(processor.firstRune[first], piece.text)
			}
		case spUnknown:
			if processor.unkID >= 0 {
				return nil, fmt.Errorf("tokenizers: %s defines more than one unknown piece", path)
			}
			processor.unkID = id
		case spByte:
			value, ok := parseBytePiece(piece.text)
			if !ok {
				return nil, fmt.Errorf("tokenizers: %s has an unparseable byte piece %q", path, piece.text)
			}
			if !model.byteFallback {
				return nil, fmt.Errorf("tokenizers: %s has byte piece %q without byte_fallback", path, piece.text)
			}
			processor.byteToID[byte(value)] = id
			processor.idToByte[id] = byte(value)
		}
	}
	if processor.unkID < 0 {
		return nil, fmt.Errorf("tokenizers: %s defines no unknown piece", path)
	}
	if model.byteFallback && len(processor.byteToID) != 256 {
		return nil, fmt.Errorf("tokenizers: %s has %d of 256 byte pieces", path, len(processor.byteToID))
	}
	for _, candidates := range processor.firstRune {
		sort.Slice(candidates, func(left, right int) bool { return len(candidates[left]) > len(candidates[right]) })
	}
	return processor, nil
}

func filepathBase(path string) string {
	if index := strings.LastIndexAny(path, `/\`); index >= 0 {
		return path[index+1:]
	}
	return path
}

// mergeSymbols performs the pinned byte-pair merge over one symbol list: repeatedly merge
// the adjacent pair whose merged piece has the highest score, with the leftmost pair winning
// a tie. The pair must be adjacent in the *current* symbol list, so a merged symbol has to be
// offered its next live neighbour — skipping that is what stops "en"+"d" from becoming "end".
//
// It is a separate function so the tie-break comparison is reachable in isolation: no pinned
// model contains a text whose tokenization depends on it (docs/tokenizer-parity-plan.md
// §9.1), so the corpus replay cannot exercise it and only a direct test can.
func (s *SentencePiece) mergeSymbols(symbols []string) []string {
	merged := append([]string{}, symbols...)
	for len(merged) > 1 {
		bestIndex := -1
		var bestScore float32
		for index := 0; index+1 < len(merged); index++ {
			id, ok := s.pieceToID[merged[index]+merged[index+1]]
			if !ok {
				continue
			}
			score := s.pieces[id].score
			if bestIndex < 0 || score > bestScore {
				bestIndex = index
				bestScore = score
			}
		}
		if bestIndex < 0 {
			break
		}
		merged[bestIndex] = merged[bestIndex] + merged[bestIndex+1]
		merged = append(merged[:bestIndex+1], merged[bestIndex+2:]...)
	}
	return merged
}

// Encode tokenizes text and returns the ids and the piece text of each id, which is what
// the pinned encode route returns as ids and chunks. Text that still carries an unpaired
// surrogate as WTF-8 is converted first, because the pinned port's own conversion is part
// of its observable behaviour.
func (s *SentencePiece) Encode(text string) ([]int, []string) {
	normalized := s.normalize(ConvertWTFSurrogatesForSentencePiece(text))
	symbols := s.split(normalized)
	if len(symbols) == 0 {
		return []int{}, []string{}
	}
	merged := s.mergeSymbols(symbols)

	ids := make([]int, 0, len(merged))
	chunks := make([]string, 0, len(merged))
	for _, symbol := range merged {
		if id, ok := s.pieceToID[symbol]; ok {
			ids = append(ids, id)
			chunks = append(chunks, symbol)
			continue
		}
		if s.byteFallback {
			for byteIndex := 0; byteIndex < len(symbol); byteIndex++ {
				id := s.byteToID[symbol[byteIndex]]
				ids = append(ids, id)
				chunks = append(chunks, s.pieces[id].text)
			}
			continue
		}
		ids = append(ids, s.unkID)
		chunks = append(chunks, symbol)
	}
	return ids, chunks
}

// normalize applies the pinned normalizer: an optional dummy prefix, whitespace escaping,
// and optional extra-whitespace removal. The precompiled charsmap is empty in every pinned
// model, which is enforced at load time. Pinned SentencePiece adds no dummy prefix to an
// empty input, so the empty string encodes to nothing rather than to one separator.
func (s *SentencePiece) normalize(text string) string {
	if text == "" {
		return ""
	}
	if s.addDummyPrefix {
		text = " " + text
	}
	if s.removeExtraWhitespaces {
		text = collapseSpaces(text)
	}
	if s.escapeWhitespaces {
		text = strings.ReplaceAll(text, " ", "\u2581")
	}
	return text
}

func collapseSpaces(text string) string {
	var builder strings.Builder
	builder.Grow(len(text))
	previousSpace := false
	for _, r := range text {
		isSpace := r == ' '
		if isSpace && previousSpace {
			continue
		}
		previousSpace = isSpace
		builder.WriteRune(r)
	}
	return builder.String()
}

// split breaks normalized text into symbols: a user-defined piece when one matches,
// otherwise a single rune.
func (s *SentencePiece) split(text string) []string {
	symbols := make([]string, 0, len(text))
	for len(text) > 0 {
		matched := ""
		first, _ := utf8.DecodeRuneInString(text)
		for _, candidate := range s.firstRune[first] {
			if strings.HasPrefix(text, candidate) && len(candidate) > len(matched) {
				matched = candidate
			}
		}
		if matched != "" {
			symbols = append(symbols, matched)
			text = text[len(matched):]
			continue
		}
		_, size := utf8.DecodeRuneInString(text)
		symbols = append(symbols, text[:size])
		text = text[size:]
	}
	return symbols
}

// DecodeSingle reproduces decodeIds([id]): an unknown or out-of-range id yields the empty
// string rather than an error, which is what the pinned JS port does and what the decode
// route therefore reports as one empty chunk.
func (s *SentencePiece) DecodeSingle(id int) string {
	text, _ := s.DecodeIDs([]int{id})
	return text
}

// DecodeIDs reproduces decodeIds(ids) for the pinned models: runs of byte pieces are
// decoded together with per-byte replacement, a control piece emits nothing, the unknown
// piece emits the model's unk_surface, and — only for a model that adds a dummy prefix —
// one leading space is dropped from the whole result. The rule follows the model's
// add_dummy_prefix rather than the first piece: the same "▁world" piece decodes to "world"
// under llama and to " world" under gemma, and the pinned route decodes each id on its own,
// so the difference is visible in every chunk list.
func (s *SentencePiece) DecodeIDs(ids []int) (string, error) {
	for _, id := range ids {
		if id < 0 || id >= len(s.pieces) {
			return "", nil
		}
	}
	var builder strings.Builder
	leadingFromSeparator := false
	emitted := false
	for index := 0; index < len(ids); {
		if _, isByte := s.idToByte[ids[index]]; isByte {
			run := make([]byte, 0, 8)
			for index < len(ids) {
				value, ok := s.idToByte[ids[index]]
				if !ok {
					break
				}
				run = append(run, value)
				index++
			}
			builder.WriteString(decodeBytesPerByte(run))
			emitted = true
			continue
		}
		piece := s.pieces[ids[index]]
		switch piece.kind {
		case spControl:
			// Control pieces emit nothing.
		case spUnknown:
			builder.WriteString(s.unkSurface)
			emitted = true
		default:
			if !emitted && strings.HasPrefix(piece.text, "\u2581") {
				leadingFromSeparator = true
			}
			builder.WriteString(strings.ReplaceAll(piece.text, "\u2581", " "))
			emitted = true
		}
		index++
	}
	text := builder.String()
	if s.addDummyPrefix && leadingFromSeparator && strings.HasPrefix(text, " ") {
		text = text[1:]
	}
	return text, nil
}

// decodeBytesPerByte decodes a byte run the way the pinned port does: every byte that
// cannot continue a valid sequence becomes its own replacement character. This differs
// from the TextDecoder rule the tiktoken routes use, which consumes a maximal subpart.
func decodeBytesPerByte(run []byte) string {
	var builder strings.Builder
	builder.Grow(len(run))
	for len(run) > 0 {
		r, size := utf8.DecodeRune(run)
		builder.WriteRune(r)
		run = run[size:]
	}
	return builder.String()
}

// CountArrayTokens reproduces countSentencepieceArrayTokens: the values of every message
// are flattened in order and joined with a blank line, then tokenized as one string.
func (s *SentencePiece) CountArrayTokens(messages []Message) int {
	values := make([]string, 0, len(messages))
	for _, message := range messages {
		for _, entry := range message {
			values = append(values, stringifyValue(entry.Value))
		}
	}
	ids, _ := s.Encode(strings.Join(values, "\n\n"))
	return len(ids)
}

// stringifyValue reproduces JavaScript's string coercion of a JSON value as it appears in
// Object.values(...).join("\n\n"): null becomes an empty string, arrays join their
// elements with commas, and objects become "[object Object]".
func stringifyValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return formatJSNumber(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, stringifyValue(item))
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return fmt.Sprint(typed)
	}
}

// formatJSNumber renders a float64 the way JavaScript's Number#toString does for the
// values that can appear in a parsed JSON body.
func formatJSNumber(value float64) string {
	if value == math.Trunc(value) && math.Abs(value) < 1e21 {
		return fmt.Sprintf("%.0f", value)
	}
	return fmt.Sprintf("%g", value)
}

// --- protobuf wire format -------------------------------------------------------------

type spModel struct {
	pieces                 []spPiece
	modelType              int
	byteFallback           bool
	unkSurface             string
	normalizerCharsmap     []byte
	addDummyPrefix         bool
	removeExtraWhitespaces bool
	escapeWhitespaces      bool
}

var errTruncatedProto = errors.New("truncated protobuf message")

func parseSentencePieceModel(raw []byte) (*spModel, error) {
	model := &spModel{
		unkSurface:             " \u2047 ",
		addDummyPrefix:         true,
		removeExtraWhitespaces: true,
		escapeWhitespaces:      true,
	}
	fields, err := protoFields(raw)
	if err != nil {
		return nil, err
	}
	for _, field := range fields {
		switch field.number {
		case 1:
			piece, err := parseSentencePiecePiece(field.bytes)
			if err != nil {
				return nil, err
			}
			model.pieces = append(model.pieces, piece)
		case 2:
			if err := parseTrainerSpec(field.bytes, model); err != nil {
				return nil, err
			}
		case 3:
			if err := parseNormalizerSpec(field.bytes, model); err != nil {
				return nil, err
			}
		}
	}
	if len(model.pieces) == 0 {
		return nil, errors.New("model has no pieces")
	}
	return model, nil
}

func parseSentencePiecePiece(raw []byte) (spPiece, error) {
	piece := spPiece{kind: spNormal}
	fields, err := protoFields(raw)
	if err != nil {
		return piece, err
	}
	for _, field := range fields {
		switch field.number {
		case 1:
			piece.text = string(field.bytes)
		case 2:
			piece.score = math.Float32frombits(binary.LittleEndian.Uint32(field.bytes))
		case 3:
			piece.kind = spPieceKind(field.value)
		}
	}
	return piece, nil
}

func parseTrainerSpec(raw []byte, model *spModel) error {
	fields, err := protoFields(raw)
	if err != nil {
		return err
	}
	for _, field := range fields {
		switch field.number {
		case 3:
			model.modelType = int(field.value)
		case 35:
			model.byteFallback = field.value != 0
		case 44:
			model.unkSurface = string(field.bytes)
		}
	}
	return nil
}

func parseNormalizerSpec(raw []byte, model *spModel) error {
	fields, err := protoFields(raw)
	if err != nil {
		return err
	}
	for _, field := range fields {
		switch field.number {
		case 2:
			model.normalizerCharsmap = field.bytes
		case 3:
			model.addDummyPrefix = field.value != 0
		case 4:
			model.removeExtraWhitespaces = field.value != 0
		case 5:
			model.escapeWhitespaces = field.value != 0
		}
	}
	return nil
}

type protoField struct {
	number int
	value  uint64
	bytes  []byte
}

func protoFields(raw []byte) ([]protoField, error) {
	var fields []protoField
	for len(raw) > 0 {
		key, size := binary.Uvarint(raw)
		if size <= 0 {
			return nil, errTruncatedProto
		}
		raw = raw[size:]
		field := protoField{number: int(key >> 3)}
		switch key & 7 {
		case 0:
			value, size := binary.Uvarint(raw)
			if size <= 0 {
				return nil, errTruncatedProto
			}
			field.value = value
			raw = raw[size:]
		case 1:
			if len(raw) < 8 {
				return nil, errTruncatedProto
			}
			field.bytes = raw[:8]
			raw = raw[8:]
		case 2:
			length, size := binary.Uvarint(raw)
			if size <= 0 || uint64(len(raw)-size) < length {
				return nil, errTruncatedProto
			}
			raw = raw[size:]
			field.bytes = raw[:length]
			raw = raw[length:]
		case 5:
			if len(raw) < 4 {
				return nil, errTruncatedProto
			}
			field.bytes = raw[:4]
			raw = raw[4:]
		default:
			return nil, fmt.Errorf("unsupported protobuf wire type %d", key&7)
		}
		fields = append(fields, field)
	}
	return fields, nil
}

// parseBytePiece parses a "<0xXY>" byte piece.
func parseBytePiece(text string) (int, bool) {
	if !strings.HasPrefix(text, "<0x") || !strings.HasSuffix(text, ">") {
		return 0, false
	}
	digits := text[3 : len(text)-1]
	if len(digits) != 2 {
		return 0, false
	}
	value := 0
	for index := 0; index < len(digits); index++ {
		digit := digits[index]
		switch {
		case digit >= '0' && digit <= '9':
			value = value*16 + int(digit-'0')
		case digit >= 'A' && digit <= 'F':
			value = value*16 + int(digit-'A') + 10
		case digit >= 'a' && digit <= 'f':
			value = value*16 + int(digit-'a') + 10
		default:
			return 0, false
		}
	}
	return value, true
}
