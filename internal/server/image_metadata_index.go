package server

import (
	"bytes"
	"encoding/json"
	"github.com/cocokoishi/gotavern/internal/httpx"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const imageMetadataIndexFilename = "image-metadata.json"

type orderedNodeJSON struct {
	kind   byte
	object []orderedNodeJSONEntry
	array  []orderedNodeJSON
	scalar any
}

type orderedNodeJSONEntry struct {
	key   string
	value orderedNodeJSON
}

func (runtime *accountRuntime) serveBackgroundFolders(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}

	index := readImageMetadataIndex(directories["root"])

	if index.kind == 'n' {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	folders, hasFolders := index.member("folders")
	if !hasFolders || !folders.truthy() {
		folders = orderedNodeJSON{kind: 'a', array: []orderedNodeJSON{}}
	}
	images, hasImages := index.member("images")
	entries, enumerable := images.entries()
	if !hasImages || !enumerable {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}

	imageFolderMap := orderedNodeJSON{kind: 'o'}
	for _, entry := range entries {
		metadata, isObject := entry.value, entry.value.kind == 'o'
		if !isObject {
			continue
		}
		folderIDs, hasFolderIDs := metadata.member("folderIds")
		if !hasFolderIDs || folderIDs.kind != 'a' || len(folderIDs.array) == 0 {
			continue
		}
		filename := entry.key
		if slash := strings.LastIndexByte(entry.key, '/'); slash >= 0 {
			filename = entry.key[slash+1:]
			if filename == "" {
				filename = entry.key
			}
		}
		// Assignment to this property changes Object.prototype on the pinned
		// endpoint's ordinary object, so JSON.stringify does not emit it.
		if filename == "__proto__" {
			continue
		}
		imageFolderMap.setMember(filename, folderIDs)
	}

	respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "folders", value: folders},
		{key: "imageFolderMap", value: imageFolderMap},
	}})
}

func (runtime *accountRuntime) serveImageMetadataFoldersGet(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}

	index := readImageMetadataIndex(directories["root"])
	if index.kind == 'n' {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error."})
		return
	}
	folders, hasFolders := index.member("folders")
	if !hasFolders || !folders.truthy() {
		folders = orderedNodeJSON{kind: 'a', array: []orderedNodeJSON{}}
	}
	respondOrderedNodeJSON(w, http.StatusOK, folders)
}

func readImageMetadataIndex(userRoot string) orderedNodeJSON {
	index := defaultImageMetadataIndex()
	indexBytes, err := os.ReadFile(filepath.Join(userRoot, imageMetadataIndexFilename))
	if err != nil {
		return index
	}
	if parsed, parseErr := decodeOrderedNodeJSON(indexBytes); parseErr == nil {
		return parsed
	}
	return index
}

func defaultImageMetadataIndex() orderedNodeJSON {
	return orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "version", value: orderedNodeJSON{kind: 'v', scalar: float64(1)}},
		{key: "images", value: orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{}}},
		{key: "folders", value: orderedNodeJSON{kind: 'a', array: []orderedNodeJSON{}}},
	}}
}

func decodeOrderedNodeJSON(raw []byte) (orderedNodeJSON, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := decodeOrderedNodeJSONValue(decoder)
	if err != nil {
		return orderedNodeJSON{}, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return orderedNodeJSON{}, io.ErrUnexpectedEOF
		}
		return orderedNodeJSON{}, err
	}
	return value, nil
}

func decodeOrderedNodeJSONValue(decoder *json.Decoder) (orderedNodeJSON, error) {
	token, err := decoder.Token()
	if err != nil {
		return orderedNodeJSON{}, err
	}
	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			object := orderedNodeJSON{kind: 'o'}
			positions := make(map[string]int)
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return orderedNodeJSON{}, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return orderedNodeJSON{}, io.ErrUnexpectedEOF
				}
				child, err := decodeOrderedNodeJSONValue(decoder)
				if err != nil {
					return orderedNodeJSON{}, err
				}
				if index, exists := positions[key]; exists {
					object.object[index].value = child
				} else {
					positions[key] = len(object.object)
					object.object = append(object.object, orderedNodeJSONEntry{key: key, value: child})
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim('}') {
				return orderedNodeJSON{}, io.ErrUnexpectedEOF
			}
			return object, nil
		case '[':
			array := orderedNodeJSON{kind: 'a'}
			for decoder.More() {
				child, err := decodeOrderedNodeJSONValue(decoder)
				if err != nil {
					return orderedNodeJSON{}, err
				}
				array.array = append(array.array, child)
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim(']') {
				return orderedNodeJSON{}, io.ErrUnexpectedEOF
			}
			return array, nil
		}
	case nil:
		return orderedNodeJSON{kind: 'n'}, nil
	case string:
		return orderedNodeJSON{kind: 's', scalar: value}, nil
	case bool:
		return orderedNodeJSON{kind: 'b', scalar: value}, nil
	case json.Number:
		number, parseErr := strconv.ParseFloat(value.String(), 64)
		if parseErr != nil {
			if numberErr, ok := parseErr.(*strconv.NumError); !ok || numberErr.Err != strconv.ErrRange {
				return orderedNodeJSON{}, parseErr
			}
		}
		return orderedNodeJSON{kind: 'v', scalar: number}, nil
	}
	return orderedNodeJSON{}, io.ErrUnexpectedEOF
}

func (value orderedNodeJSON) member(key string) (orderedNodeJSON, bool) {
	if value.kind != 'o' {
		return orderedNodeJSON{}, false
	}
	for _, entry := range value.object {
		if entry.key == key {
			return entry.value, true
		}
	}
	return orderedNodeJSON{}, false
}

func (value *orderedNodeJSON) setMember(key string, member orderedNodeJSON) {
	for index := range value.object {
		if value.object[index].key == key {
			value.object[index].value = member
			return
		}
	}
	value.object = append(value.object, orderedNodeJSONEntry{key: key, value: member})
}

func (value *orderedNodeJSON) deleteMember(key string) bool {
	for index := range value.object {
		if value.object[index].key == key {
			value.object = append(value.object[:index], value.object[index+1:]...)
			return true
		}
	}
	return false
}

func (value orderedNodeJSON) entries() ([]orderedNodeJSONEntry, bool) {
	switch value.kind {
	case 'o':
		// FAST PATH (alpha.19): when no member key is an array index, `JSON.stringify` emits every member in
		// insertion order, and the stable sort below would be the identity permutation. Returning the object's
		// own slice avoids one copy plus a comparison-sort per object per marshal -- /api/characters/all
		// marshals ~4-5 objects per card, and this was 44% of that route's allocation objects. The result is a
		// READ-ONLY VIEW: a caller that deletes or reorders members of THIS object while ranging over the result
		// must snapshot the slice first (deleting shifts the shared backing array and the range skips members;
		// image_metadata_cleanup.go does exactly that and now takes a snapshot, which is also what pinned's
		// Object.keys() iteration does).
		hasArrayIndex := false
		for index := range value.object {
			if _, isIndex := nodeArrayIndex(value.object[index].key); isIndex {
				hasArrayIndex = true
				break
			}
		}
		if !hasArrayIndex {
			return value.object, true
		}
		entries := append([]orderedNodeJSONEntry(nil), value.object...)
		sort.SliceStable(entries, func(i, j int) bool {
			iIndex, iIsIndex := nodeArrayIndex(entries[i].key)
			jIndex, jIsIndex := nodeArrayIndex(entries[j].key)
			if iIsIndex != jIsIndex {
				return iIsIndex
			}
			return iIsIndex && iIndex < jIndex
		})
		return entries, true
	case 'a':
		entries := make([]orderedNodeJSONEntry, len(value.array))
		for index, item := range value.array {
			entries[index] = orderedNodeJSONEntry{key: strconv.Itoa(index), value: item}
		}
		return entries, true
	case 's':
		text := value.scalar.(string)
		units := utf16.Encode([]rune(text))
		entries := make([]orderedNodeJSONEntry, len(units))
		for index, unit := range units {
			child := orderedNodeJSON{kind: 's', scalar: string(rune(unit))}
			if unit >= 0xd800 && unit <= 0xdfff {
				child = orderedNodeJSON{kind: 'h', scalar: unit}
			}
			entries[index] = orderedNodeJSONEntry{key: strconv.Itoa(index), value: child}
		}
		return entries, true
	case 'n':
		return nil, false
	default:
		return nil, true
	}
}

// nodeArrayIndex reports whether a member key is a JavaScript array index, i.e. whether JSON.stringify emits it
// in the numeric-key block (ascending) ahead of the insertion-order block.
//
// It is EXACTLY equivalent to `index, err := strconv.ParseUint(key, 10, 32); err == nil && index != 4294967295
// && strconv.FormatUint(index, 10) == key`, which is what it replaces, but it cannot allocate: ParseUint returns
// a *strconv.NumError for every non-numeric key, and this predicate runs once per key per object per marshal
// (24.5% of /api/characters/all's allocation objects in the alpha.19 profile). The equivalence cases are:
//   - "" and any key containing a non-ASCII-digit byte -> not an index (ParseUint rejects them);
//   - more than 10 digits -> out of uint32 range (ParseUint reports ErrRange);
//   - a leading zero with length > 1 ("007") -> ParseUint accepts it but FormatUint(7) != "007";
//   - "4294967295" -> explicitly excluded by the original predicate; anything larger is out of range;
//   - "0" -> index 0; "4294967294" -> index 4294967294.
func nodeArrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 {
		return 0, false
	}
	if len(key) > 1 && key[0] == '0' {
		return 0, false
	}
	var index uint64
	for offset := 0; offset < len(key); offset++ {
		character := key[offset]
		if character < '0' || character > '9' {
			return 0, false
		}
		index = index*10 + uint64(character-'0')
	}
	if index >= 4294967295 {
		return 0, false
	}
	return index, true
}

func (value orderedNodeJSON) truthy() bool {
	switch value.kind {
	case 'n':
		return false
	case 'b':
		return value.scalar == true
	case 's':
		return value.scalar.(string) != ""
	case 'h':
		return true
	case 'v':
		return value.scalar.(float64) != 0
	default:
		return true
	}
}

func respondOrderedNodeJSON(w http.ResponseWriter, status int, value orderedNodeJSON) {
	respondOrderedNodeJSONHint(w, status, value, 0)
}

// respondOrderedNodeJSONHint is respondOrderedNodeJSON with an optional serialized-size hint. The hint only
// pre-sizes the single output buffer; it can never change the bytes (the byte-identity test proves that with a
// deliberately wrong hint).
func respondOrderedNodeJSONHint(w http.ResponseWriter, status int, value orderedNodeJSON, hint int) {
	body, err := marshalOrderedNodeJSONHint(value, hint)
	if err != nil {
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", httpx.WeakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func marshalOrderedNodeJSON(value orderedNodeJSON) ([]byte, error) {
	return marshalOrderedNodeJSONHint(value, 0)
}

// marshalOrderedNodeJSONHint is the single-buffer ordered-JSON serializer. alpha.20 replaced the recursive
// per-object `bytes.Buffer` construction with an append-only writer: the old shape allocated a fresh buffer for
// EVERY nested object and array and a fresh []byte for every member key and string, so a 4 MiB world book paid
// ~35 MB of allocations per marshal (measured: BenchmarkA20MarshalWorld4MB). The bytes produced are identical;
// the hint only pre-sizes the ONE buffer, and a wrong hint changes the number of grows, never the content (the
// byte-identity test replays the frozen pre-change golden with hints 0, 1, exact+7 and 1<<20).
func marshalOrderedNodeJSONHint(value orderedNodeJSON, hint int) ([]byte, error) {
	capacity := hint
	if capacity < 0 {
		capacity = 0
	}
	if capacity > 0 {
		// The source length is a close estimate, not the exact serialized length (a pretty-printed source file
		// shrinks, an escaped one grows). A small slack keeps a near-exact hint from triggering one needless
		// doubling at the end; it only reserves capacity.
		capacity += capacity/8 + 64
	}
	writer := &orderedJSONWriter{data: make([]byte, 0, capacity)}
	if err := writer.writeOrderedNode(value); err != nil {
		return nil, err
	}
	return writer.data, nil
}

// orderedJSONWriter appends the ordered-JSON serialization into ONE buffer. It exists because Go's slice
// append grows large slices by ~1.25x, so the old append(dst, ...) prototype still allocated about 3x the final
// body for a 4 MiB world book (measured: 24.5 MB/op); this writer doubles instead, and a caller that knows the
// source size (the world-info route passes the file length) pre-sizes it so the total is ~1x the body.
type orderedJSONWriter struct {
	data []byte
}

func (writer *orderedJSONWriter) reserve(extra int) {
	if extra <= cap(writer.data)-len(writer.data) {
		return
	}
	needed := len(writer.data) + extra
	capacity := cap(writer.data)
	if capacity < 64 {
		capacity = 64
	}
	for capacity < needed {
		capacity *= 2
	}
	next := make([]byte, len(writer.data), capacity)
	copy(next, writer.data)
	writer.data = next
}

func (writer *orderedJSONWriter) writeByte(character byte) {
	writer.reserve(1)
	writer.data = append(writer.data, character)
}

func (writer *orderedJSONWriter) writeString(value string) {
	writer.reserve(len(value))
	writer.data = append(writer.data, value...)
}

// writeEscapedString reserves only the PLAIN encoded size (the two quotes plus the string bytes). The pinned
// escaper can expand control bytes to six bytes each, but the ordered-JSON routes carry prose and identifiers
// where expansion is rare; reserving the 6x worst case on every string would over-reserve near the end of a
// pre-sized buffer and trigger a needless doubling (measured: the hinted chat arm regressed 2.99 MB -> 3.89 MB
// per op when it did). The escaper's own append grows correctly if expansion happens, so this is a sizing choice
// and never a correctness one.
func (writer *orderedJSONWriter) writeEscapedString(value string) {
	writer.reserve(len(value) + 2)
	writer.data = appendCharacterJSONString(writer.data, value)
}

func (writer *orderedJSONWriter) writeNumber(value float64) {
	writer.reserve(32)
	writer.data = appendECMAScriptNumber(writer.data, value)
}

func (writer *orderedJSONWriter) writeOrderedNode(value orderedNodeJSON) error {
	switch value.kind {
	case 'o':
		writer.writeByte('{')
		entries, _ := value.entries()
		for index, entry := range entries {
			if index > 0 {
				writer.writeByte(',')
			}
			writer.writeEscapedString(entry.key)
			writer.writeByte(':')
			if err := writer.writeOrderedNode(entry.value); err != nil {
				return err
			}
		}
		writer.writeByte('}')
		return nil
	case 'a':
		writer.writeByte('[')
		for index, item := range value.array {
			if index > 0 {
				writer.writeByte(',')
			}
			if err := writer.writeOrderedNode(item); err != nil {
				return err
			}
		}
		writer.writeByte(']')
		return nil
	case 's':
		writer.writeEscapedString(value.scalar.(string))
		return nil
	case 'h':
		// A lone UTF-16 surrogate is emitted as the JSON escape Node's JSON.stringify produces.
		unit := value.scalar.(uint16)
		hex := strconv.FormatUint(uint64(unit), 16)
		writer.reserve(8)
		writer.data = append(writer.data, '"', '\\', 'u')
		for padding := len(hex); padding < 4; padding++ {
			writer.data = append(writer.data, '0')
		}
		writer.data = append(writer.data, hex...)
		writer.data = append(writer.data, '"')
		return nil
	case 'v':
		writer.writeNumber(value.scalar.(float64))
		return nil
	default:
		encoded, err := marshalNodeJSON(value.scalar)
		if err != nil {
			return err
		}
		writer.writeBytes(encoded)
		return nil
	}
}

func (writer *orderedJSONWriter) writeBytes(value []byte) {
	writer.reserve(len(value))
	writer.data = append(writer.data, value...)
}

// appendCharacterJSONString is the append-based form of the pinned JSON string encoding in
// writeCharacterJSONString. It exists so the ordered-JSON serializer does not allocate one temporary []byte per
// member key and string. Both encoders must emit identical bytes, and the byte-identity test
// (a20_marshal_byte_identity_test.go) replays the frozen pre-change golden over controls, U+2028/U+2029,
// invalid UTF-8, lone surrogates and astral runes for both.
func appendCharacterJSONString(dst []byte, value string) []byte {
	const hexDigits = "0123456789abcdef"
	dst = append(dst, '"')
	start := 0
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character < utf8.RuneSelf {
			if character >= 0x20 && character != '"' && character != '\\' {
				continue
			}
			dst = append(dst, value[start:index]...)
			switch character {
			case '"':
				dst = append(dst, '\\', '"')
			case '\\':
				dst = append(dst, '\\', '\\')
			case '\b':
				dst = append(dst, '\\', 'b')
			case '\t':
				dst = append(dst, '\\', 't')
			case '\n':
				dst = append(dst, '\\', 'n')
			case '\f':
				dst = append(dst, '\\', 'f')
			case '\r':
				dst = append(dst, '\\', 'r')
			default:
				dst = append(dst, '\\', 'u', '0', '0', hexDigits[character>>4], hexDigits[character&0xF])
			}
			start = index + 1
			continue
		}
		runeValue, size := utf8.DecodeRuneInString(value[index:])
		if runeValue == utf8.RuneError && size == 1 {
			// encoding/json replaces each invalid byte with U+FFFD and keeps scanning at the next byte.
			dst = append(dst, value[start:index]...)
			dst = append(dst, "\uFFFD"...)
			start = index + 1
			continue
		}
		index += size - 1
	}
	dst = append(dst, value[start:]...)
	return append(dst, '"')
}

// appendECMAScriptNumber appends the same text marshalECMAScriptNumber returns, without the temporary []byte on
// the common (non-scientific) path. The rare scientific branch keeps the shared formatter and copies its bytes.
func appendECMAScriptNumber(dst []byte, value float64) []byte {
	if value == 0 {
		return append(dst, '0')
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.AppendFloat(dst, value, 'f', -1, 64)
	}
	encoded, err := marshalECMAScriptNumber(value)
	if err != nil {
		return append(dst, "null"...)
	}
	return append(dst, encoded...)
}

func (value orderedNodeJSON) javascriptString() (string, error) {
	switch value.kind {
	case 'n':
		return "null", nil
	case 's':
		return value.scalar.(string), nil
	case 'h':
		return string(utf16.Decode([]uint16{value.scalar.(uint16)})), nil
	case 'b':
		return strconv.FormatBool(value.scalar.(bool)), nil
	case 'v':
		number := value.scalar.(float64)
		if math.IsInf(number, 1) {
			return "Infinity", nil
		}
		if math.IsInf(number, -1) {
			return "-Infinity", nil
		}
		if math.IsNaN(number) {
			return "NaN", nil
		}
		return javascriptNumberString(number), nil
	case 'a':
		parts := make([]string, len(value.array))
		for index, item := range value.array {
			if item.kind == 'n' {
				continue
			}
			part, err := item.javascriptString()
			if err != nil {
				return "", err
			}
			parts[index] = part
		}
		return strings.Join(parts, ","), nil
	case 'o':
		if _, exists := value.member("toString"); exists {
			return "", io.ErrUnexpectedEOF
		}
		return "[object Object]", nil
	default:
		return "", io.ErrUnexpectedEOF
	}
}

// marshalNodeJSONString is the JSON string encoding for the GENERIC ordered-JSON routes (world info, chats,
// image metadata). It used to build an encoding/json v2 encoder and then run two bytes.ReplaceAll passes over
// its output; the character domain's escaper (writeCharacterJSONString) was differentially pinned to exactly
// that output in alpha.18 (single-byte controls, \b\t\n\f\r, quote/backslash, U+2028/U+2029 emitted RAW,
// invalid UTF-8 replaced with U+FFFD) and is now shared here, so the generic routes stop paying one encoder
// allocation plus two whole-string copies per string. In alpha.19 the 4 MB world-info response spent 48.5 MB
// (14.5% of its allocation window) in bytes.Replace for this path.
//
// KEEPING THE PIN HONEST: the differential test that proves this equivalence must compare against an
// encoder-based REFERENCE, not against the production function itself. The reference lives in
// a19_perf_pins_test.go (a19ReferenceMarshalNodeJSONStringEncoder) and characters_scale_optimization_test.go
// was updated to use it, so the comparison still has teeth.
func marshalNodeJSONString(value string) ([]byte, error) {
	return appendCharacterJSONString(nil, value), nil
}

func marshalECMAScriptNumber(value float64) ([]byte, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return []byte("null"), nil
	}
	if value == 0 {
		return []byte("0"), nil
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return []byte(strconv.FormatFloat(value, 'f', -1, 64)), nil
	}
	encoded := strconv.FormatFloat(value, 'e', -1, 64)
	exponentIndex := strings.IndexByte(encoded, 'e')
	if exponentIndex < 0 {
		return []byte(encoded), nil
	}
	exponent, err := strconv.Atoi(encoded[exponentIndex+1:])
	if err != nil {
		return []byte(encoded), nil
	}
	sign := "+"
	if exponent < 0 {
		sign = "-"
		exponent = -exponent
	}
	return []byte(encoded[:exponentIndex] + "e" + sign + strconv.Itoa(exponent)), nil
}
