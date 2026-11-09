package server

// alpha.19 performance pins: the byte-identity proof for the ordered-JSON fast paths.
//
// WHY THIS FILE EXISTS. The alpha.19 hotspot profiles attributed 44% of /api/characters/all's allocation
// objects to `orderedNodeJSON.entries` (one slice copy plus a stable sort per object per marshal) and 24.5% to
// the `strconv.ParseUint` error the numeric-key predicate allocated for every non-numeric key. The fix adds a
// fast path that returns the object's own entry slice when no key is an array index, and a digit-only
// predicate. A performance change may not alter one output byte, so this file proves the equivalence three
// ways:
//
//  1. THE REFERENCE IMPLEMENTATION IS KEPT, in this test file, as the literal pre-change code (copy + stable
//     sort + ParseUint predicate), and the production writer is compared against a reference writer that uses
//     it. If the fast path changes order in ANY construct, the bytes differ here.
//  2. THE ORDER RULE IS ANCHORED TO NODE, not to our own reading of it: the integer-like-key vectors below
//     carry the exact output of `JSON.stringify(JSON.parse(doc))` recorded from the pinned Node runtime
//     (v24.19.0) by the command quoted above the table, including boundary keys `"4294967294"`,
//     `"4294967295"` (NOT an array index), `"4294967296"` (out of range), leading zeros, whitespace/sign
//     look-alikes and nested objects.
//  3. THE ROUTE ITSELF IS COMPARED, not only the marshal helper: for generated 1/100/1,000/10,000-card
//     libraries the /api/characters/all response bytes are compared against the reference writer over the
//     nodes the route projects. Those cards carry a fixed `chat` and `create_date`, so the response is
//     deterministic for the tree (only `date_added` comes from the file's ctime, which is fixed once the file
//     is written) and the comparison is a real before/after byte equality, not a semantic one.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// --- the pre-change implementation, kept verbatim as the reference -------------------------------------------------

// a19ReferenceNodeArrayIndex is the predicate the fast path replaces: `strconv.ParseUint(key, 10, 32)` plus the
// `FormatUint` round-trip and the explicit 4294967295 exclusion.
func a19ReferenceNodeArrayIndex(key string) (uint64, bool) {
	if key == "" {
		return 0, false
	}
	index, err := strconv.ParseUint(key, 10, 32)
	if err != nil || index == 4294967295 || strconv.FormatUint(index, 10) != key {
		return 0, false
	}
	return index, true
}

// a19ReferenceEntries is the pre-change entries(): copy the object's entries, then stable-sort by the
// array-index rule.
func a19ReferenceEntries(value orderedNodeJSON) ([]orderedNodeJSONEntry, bool) {
	switch value.kind {
	case 'o':
		entries := append([]orderedNodeJSONEntry(nil), value.object...)
		sort.SliceStable(entries, func(i, j int) bool {
			iIndex, iIsIndex := a19ReferenceNodeArrayIndex(entries[i].key)
			jIndex, jIsIndex := a19ReferenceNodeArrayIndex(entries[j].key)
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
		units := []rune(text)
		entries := make([]orderedNodeJSONEntry, len(units))
		for index, unit := range units {
			child := orderedNodeJSON{kind: 's', scalar: string(unit)}
			if unit >= 0xd800 && unit <= 0xdfff {
				child = orderedNodeJSON{kind: 'h', scalar: uint16(unit)}
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

// a19ReferenceWriteCharacterJSON mirrors writeCharacterJSON but resolves object members through the reference
// entries(). Every other encoder is the production one, so the comparison isolates exactly the change.
func a19ReferenceWriteCharacterJSON(body *bytes.Buffer, value orderedNodeJSON) error {
	switch value.kind {
	case 'o':
		body.WriteByte('{')
		entries, _ := a19ReferenceEntries(value)
		written := 0
		for _, entry := range entries {
			if entry.value.kind == nodeUndefinedKind {
				continue
			}
			if written > 0 {
				body.WriteByte(',')
			}
			written++
			writeCharacterJSONString(body, entry.key)
			body.WriteByte(':')
			if err := a19ReferenceWriteCharacterJSON(body, entry.value); err != nil {
				return err
			}
		}
		body.WriteByte('}')
	case 'a':
		body.WriteByte('[')
		for index, item := range value.array {
			if index > 0 {
				body.WriteByte(',')
			}
			if item.kind == nodeUndefinedKind {
				body.WriteString("null")
				continue
			}
			if err := a19ReferenceWriteCharacterJSON(body, item); err != nil {
				return err
			}
		}
		body.WriteByte(']')
	case 's':
		writeCharacterJSONString(body, value.scalar.(string))
	case 'h':
		unit := value.scalar.(uint16)
		hex := strconv.FormatUint(uint64(unit), 16)
		body.WriteString(`"\u` + strings.Repeat("0", 4-len(hex)) + hex + `"`)
	case 'v':
		encoded, err := marshalECMAScriptNumber(value.scalar.(float64))
		if err != nil {
			return err
		}
		body.Write(encoded)
	case nodeUndefinedKind:
		body.WriteString("null")
	default:
		encoded, err := marshalNodeJSON(value.scalar)
		if err != nil {
			return err
		}
		body.Write(encoded)
	}
	return nil
}

func a19ReferenceMarshalCharacterJSON(value orderedNodeJSON) ([]byte, error) {
	var body bytes.Buffer
	if err := a19ReferenceWriteCharacterJSON(&body, value); err != nil {
		return nil, err
	}
	return body.Bytes(), nil
}

// a19ReferenceMarshalOrderedNodeJSON mirrors marshalOrderedNodeJSON with the reference entries.
func a19ReferenceMarshalOrderedNodeJSON(value orderedNodeJSON) ([]byte, error) {
	var body bytes.Buffer
	var write func(*bytes.Buffer, orderedNodeJSON) error
	write = func(target *bytes.Buffer, current orderedNodeJSON) error {
		switch current.kind {
		case 'o':
			target.WriteByte('{')
			entries, _ := a19ReferenceEntries(current)
			for index, entry := range entries {
				if index > 0 {
					target.WriteByte(',')
				}
				keyBytes, err := marshalNodeJSONString(entry.key)
				if err != nil {
					return err
				}
				target.Write(keyBytes)
				target.WriteByte(':')
				if err := write(target, entry.value); err != nil {
					return err
				}
			}
			target.WriteByte('}')
		case 'a':
			target.WriteByte('[')
			for index, item := range current.array {
				if index > 0 {
					target.WriteByte(',')
				}
				if err := write(target, item); err != nil {
					return err
				}
			}
			target.WriteByte(']')
		case 's':
			encoded, err := marshalNodeJSONString(current.scalar.(string))
			if err != nil {
				return err
			}
			target.Write(encoded)
		case 'h':
			unit := current.scalar.(uint16)
			hex := strconv.FormatUint(uint64(unit), 16)
			target.WriteString(`"\u` + strings.Repeat("0", 4-len(hex)) + hex + `"`)
		case 'v':
			encoded, err := marshalECMAScriptNumber(current.scalar.(float64))
			if err != nil {
				return err
			}
			target.Write(encoded)
		default:
			encoded, err := marshalNodeJSON(current.scalar)
			if err != nil {
				return err
			}
			target.Write(encoded)
		}
		return nil
	}
	if err := write(&body, value); err != nil {
		return nil, err
	}
	return body.Bytes(), nil
}

// a19FirstDifference names the first differing byte so a failure is diagnosable without a hex dump.
func a19FirstDifference(got, want []byte) string {
	limit := len(got)
	if len(want) < limit {
		limit = len(want)
	}
	for index := 0; index < limit; index++ {
		if got[index] != want[index] {
			return fmt.Sprintf("first difference at byte %d: got %q, want %q", index, string(got[index:min(index+40, len(got))]), string(want[index:min(index+40, len(want))]))
		}
	}
	if len(got) != len(want) {
		return fmt.Sprintf("length differs: got %d, want %d (tail got %q, want %q)", len(got), len(want), tailBytes(got, 40), tailBytes(want, 40))
	}
	return "identical"
}

func tailBytes(value []byte, count int) string {
	if len(value) <= count {
		return string(value)
	}
	return string(value[len(value)-count:])
}

// --- 1. Node-anchored ordering vectors ---------------------------------------------------------------------------

// a19NodeOrderingVectors are (input document, exact JSON.stringify output) pairs recorded from the pinned Node
// runtime. Command used to record them (v24.19.0, 2026-11-08):
//
//	node -e 'for (const d of [...]) console.log(JSON.stringify(JSON.parse(d)))'
//
// The outputs are pasted verbatim; they pin the JS ordering rule (integer-like keys ascending first, then the
// remaining keys in insertion order) and the boundary decisions (4294967295 is NOT an array index, 4294967296
// is out of range, "01"/"00" are not indices).
var a19NodeOrderingVectors = []struct {
	name     string
	input    string
	expected string
}{
	{"empty_object", `{}`, `{}`},
	{"insertion_only", `{"b":1,"a":2}`, `{"b":1,"a":2}`},
	{"mixed_keys", `{"b":1,"2":2,"1":3,"a":4,"0":5}`, `{"0":5,"1":3,"2":2,"b":1,"a":4}`},
	{"numeric_ascending", `{"10":1,"9":2,"a":3,"2":4}`, `{"2":4,"9":2,"10":1,"a":3}`},
	{"leading_zeroes", `{"01":1,"1":2,"00":3,"0":4}`, `{"0":4,"1":2,"01":1,"00":3}`},
	{"array_index_boundary", `{"4294967295":1,"4294967294":2,"4294967296":3}`, `{"4294967294":2,"4294967295":1,"4294967296":3}`},
	// The four vectors below DISCRIMINATE the boundary: a non-index key placed BEFORE the boundary key in the
	// document is emitted first by Node, so a predicate that wrongly classifies 4294967295 / 4294967296 / "01"
	// as an array index moves them to the front and changes the bytes. The three-key vector above cannot see
	// that move because its non-index neighbour happens to sort after the boundary either way.
	{"boundary_4294967295_is_not_an_index", `{"zzz":1,"4294967295":2}`, `{"zzz":1,"4294967295":2}`},
	{"boundary_4294967294_is_an_index", `{"zzz":1,"4294967294":2}`, `{"4294967294":2,"zzz":1}`},
	{"boundary_4294967296_is_not_an_index", `{"zzz":1,"4294967296":2}`, `{"zzz":1,"4294967296":2}`},
	{"boundary_leading_zero_is_not_an_index", `{"zzz":1,"01":2}`, `{"zzz":1,"01":2}`},
	{"lookalikes", `{"-1":1,"+1":2,"1e3":3," 1":4,"1.0":5,"0x10":6}`, `{"-1":1,"+1":2,"1e3":3," 1":4,"1.0":5,"0x10":6}`},
	{"empty_and_space", `{"":1," ":2,"a":3}`, `{"":1," ":2,"a":3}`},
	{"unicode_keys", `{"emoji😀":1,"日本":2,"2":3,"1":4}`, `{"1":4,"2":3,"emoji😀":1,"日本":2}`},
	{"nested", `{"nested":{"3":1,"1":2,"b":3,"a":4},"array":[{"9":1,"1":2},{"0":3}]}`, `{"nested":{"1":2,"3":1,"b":3,"a":4},"array":[{"1":2,"9":1},{"0":3}]}`},
	{"all_numeric", `{"0":0,"1":1,"2":2}`, `{"0":0,"1":1,"2":2}`},
	{"scalars", `{"z":null,"y":true,"x":false}`, `{"z":null,"y":true,"x":false}`},
	{"array_of_objects", `[{"2":1,"1":2},{"a":3,"0":4},[],{},[{"1":1,"a":2}]]`, `[{"1":2,"2":1},{"0":4,"a":3},[],{},[{"1":1,"a":2}]]`},
	{"duplicate_key_parsed_last_wins", `{"dup":1,"dup":2}`, `{"dup":2}`},
}

func TestA19OrderedJSONFastPathMatchesNodeStringify(t *testing.T) {
	for _, vector := range a19NodeOrderingVectors {
		vector := vector
		t.Run(vector.name, func(t *testing.T) {
			parsed, err := decodeOrderedNodeJSON([]byte(vector.input))
			if err != nil {
				t.Fatalf("decode %s: %v", vector.input, err)
			}
			fast, err := marshalOrderedNodeJSON(parsed)
			if err != nil {
				t.Fatalf("marshalOrderedNodeJSON: %v", err)
			}
			if string(fast) != vector.expected {
				t.Fatalf("marshalOrderedNodeJSON(%s) = %s, Node JSON.stringify = %s (%s)",
					vector.input, fast, vector.expected, a19FirstDifference(fast, []byte(vector.expected)))
			}
		})
	}
}

// --- 2. fast path vs the pre-change reference implementation ------------------------------------------------------

// a19TortureDocuments exercise the constructs the fast path reasons about: objects with no numeric key (fast
// path returns the object's own slice), objects with numeric keys (stable sort still runs), nested combinations,
// undefined members (JSON.stringify omits them) and Unicode keys/values.
func a19TortureDocuments() []string {
	return []string{
		`{}`,
		`{"b":1,"a":2}`,
		`{"b":1,"2":2,"1":3,"a":4,"0":5}`,
		`{"10":1,"9":2,"a":3,"2":4}`,
		`{"01":1,"1":2,"00":3,"0":4}`,
		`{"4294967295":1,"4294967294":2,"4294967296":3}`,
		`{"zzz":1,"4294967295":2}`,
		`{"zzz":1,"4294967294":2}`,
		`{"zzz":1,"4294967296":2}`,
		`{"zzz":1,"01":2}`,
		`{"-1":1,"+1":2,"1e3":3," 1":4,"1.0":5,"0x10":6}`,
		`{"":1," ":2,"a":3}`,
		`{"emoji😀":1,"日本":2,"2":3,"1":4}`,
		`{"nested":{"3":1,"1":2,"b":3,"a":4},"array":[{"9":1,"1":2},{"0":3}]}`,
		`{"deep":{"deeper":{"z":1,"0":2},"list":[{"5":1,"4":2},{"a":1}]}}`,
		`{"0":0,"1":1,"2":2,"3":{"1":"x","b":"y"}}`,
		`{"z":null,"y":true,"x":false,"n":1.5,"big":1e21,"neg":-0.0,"exp":1e-7}`,
		`[{"2":1,"1":2},{"a":3,"0":4},[],{},[{"1":1,"a":2}]]`,
		`{"dup":1,"dup":2}`,
		`{"undefined_member":null,"keep":1}`,
		`{"😀":"😀","日本":{"2":"二","1":"一"}}`,
	}
}

func TestA19EntriesFastPathMatchesReferenceBytes(t *testing.T) {
	for index, document := range a19TortureDocuments() {
		document := document
		t.Run(fmt.Sprintf("doc_%02d", index), func(t *testing.T) {
			parsed, err := decodeOrderedNodeJSON([]byte(document))
			if err != nil {
				t.Fatalf("decode %s: %v", document, err)
			}
			// Add members whose value is the JavaScript `undefined` so the omission rule is exercised through
			// both writers too (the character-domain marshal omits them; the generic one never sees them).
			if parsed.kind == 'o' {
				nodeSet(&parsed, []string{"omitted_undefined"}, nodeUndefined())
			}
			fast, err := marshalCharacterJSON(parsed)
			if err != nil {
				t.Fatalf("marshalCharacterJSON: %v", err)
			}
			reference, err := a19ReferenceMarshalCharacterJSON(parsed)
			if err != nil {
				t.Fatalf("reference marshalCharacterJSON: %v", err)
			}
			if !bytes.Equal(fast, reference) {
				t.Fatalf("characters marshal differs from the pre-change implementation for %s: %s", document, a19FirstDifference(fast, reference))
			}
			fastGeneric, err := marshalOrderedNodeJSON(parsed)
			if err != nil {
				t.Fatalf("marshalOrderedNodeJSON: %v", err)
			}
			referenceGeneric, err := a19ReferenceMarshalOrderedNodeJSON(parsed)
			if err != nil {
				t.Fatalf("reference marshalOrderedNodeJSON: %v", err)
			}
			if !bytes.Equal(fastGeneric, referenceGeneric) {
				t.Fatalf("generic marshal differs from the pre-change implementation for %s: %s", document, a19FirstDifference(fastGeneric, referenceGeneric))
			}
		})
	}
}

// TestA19NodeArrayIndexMatchesReference pins the allocation-free predicate against the ParseUint one over the
// boundary corpus. A disagreement here is an output-order bug, not a performance question.
func TestA19NodeArrayIndexMatchesReference(t *testing.T) {
	keys := []string{
		"", "0", "1", "9", "10", "42", "007", "00", "01", "0000000000",
		"4294967293", "4294967294", "4294967295", "4294967296", "9999999999", "10000000000",
		"-1", "+1", " 1", "1 ", "1.0", "1e3", "0x10", "0b1", "1_000",
		"a", "A", "name", "description", "日本", "😀", "١", "１", "\x00", "1\x00",
	}
	for _, key := range keys {
		fastIndex, fastIsIndex := nodeArrayIndex(key)
		referenceIndex, referenceIsIndex := a19ReferenceNodeArrayIndex(key)
		if fastIsIndex != referenceIsIndex || (fastIsIndex && fastIndex != referenceIndex) {
			t.Fatalf("nodeArrayIndex(%q) = (%d, %v), reference = (%d, %v)", key, fastIndex, fastIsIndex, referenceIndex, referenceIsIndex)
		}
	}
}

// --- 3. route-level byte identity for the generated card libraries -------------------------------------------------

// a19PinCardJSON is a card whose projection is deterministic: `chat` and `create_date` are present in the card
// itself, so readFromV2 does not interpolate the wall clock, and date_added comes from the file's ctime, which
// is fixed once the file has been written.
func a19PinCardJSON(index int) []byte {
	return []byte(fmt.Sprintf(`{"spec":"chara_card_v2","spec_version":"2.0","name":"Pin Card %05d","description":"alpha.19 pin card %05d","personality":"pin","scenario":"pin","first_mes":"hello %05d","mes_example":"","creatorcomment":"","talkativeness":"0.5","fav":false,"chat":"A19 Pin Chat %05d","create_date":"2024-01-01T00:00:00.000Z","tags":["pin"],"data":{"name":"Pin Card %05d","description":"alpha.19 pin card %05d","personality":"pin","scenario":"pin","first_mes":"hello %05d","mes_example":"","creator_notes":"","system_prompt":"","post_history_instructions":"","alternate_greetings":[],"tags":["pin"],"creator":"pin","character_version":"1.0","extensions":{"talkativeness":"0.5","fav":false,"world":""}}}`, index, index, index, index, index, index, index))
}

func a19PinCardPNG(index int) []byte {
	var image bytes.Buffer
	image.Write(benchPNGSignature)
	image.Write(benchPNGChunk("IHDR", []byte{
		0x00, 0x00, 0x00, 0x01,
		0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00,
	}))
	image.Write(benchPNGChunk("IDAT", benchPixelIDAT()))
	image.Write(benchPNGChunk("tEXt", []byte("chara\x00"+base64.StdEncoding.EncodeToString(a19PinCardJSON(index)))))
	image.Write(benchPNGChunk("IEND", nil))
	return image.Bytes()
}

// a19PinEnvironment plants `cards` deterministic cards and returns an authenticated handler plus the data root.
func a19PinEnvironment(t *testing.T, cards int) (http.Handler, string, string, string) {
	t.Helper()
	dataRoot := t.TempDir()
	charactersRoot := filepath.Join(dataRoot, "default-user", "characters")
	if err := os.MkdirAll(charactersRoot, 0o755); err != nil {
		t.Fatalf("create character directory: %v", err)
	}
	// No chats directory: the route then reports chat_size 0 / date_last_chat 0 for every card, which is the
	// one shape that exercises calculateChatSize's ENOENT branch per card without making the response
	// depend on chat-file mtimes.
	card := a19PinCardPNG(0)
	for index := 0; index < cards; index++ {
		name := fmt.Sprintf("Pin Card %05d.png", index)
		if err := os.WriteFile(filepath.Join(charactersRoot, name), card, 0o644); err != nil {
			t.Fatalf("write card %s: %v", name, err)
		}
	}
	handler, cookie, token := a19PinAuthenticatedHandler(t, dataRoot)
	return handler, dataRoot, cookie, token
}

// a19PinAuthenticatedHandler plants the account record over an ALREADY-PLANTED data root, builds the handler and
// completes the product's own CSRF + login handshake. Split out so a test can plant its own characters/chats tree
// (the C3 listing test) and still drive the authenticated route.
func a19PinAuthenticatedHandler(t *testing.T, dataRoot string) (http.Handler, string, string) {
	t.Helper()
	installRoot := t.TempDir()
	accountJSON, err := marshalNodeJSON(struct {
		Handle   string `json:"handle"`
		Name     string `json:"name"`
		Created  int64  `json:"created"`
		Password string `json:"password"`
		Admin    bool   `json:"admin"`
		Enabled  bool   `json:"enabled"`
		Salt     string `json:"salt"`
	}{"default-user", "A19 Pin", 1700000000000, "", true, true, ""})
	if err != nil {
		t.Fatalf("marshal account record: %v", err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatalf("plant account record: %v", err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot:     installRoot,
		DataRoot:        dataRoot,
		CookieSecret:    "a19-pin-cookie-secret-0123456789abcdef",
		AccountsEnabled: true,
	})
	serve := func(request *http.Request) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	csrfResponse := serve(httptest.NewRequest(http.MethodGet, "/csrf-token", nil))
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrfResponse.Code)
	}
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatalf("decode CSRF token: %v", err)
	}
	cookies := func(cookies []*http.Cookie) string {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, cookie.Name+"="+cookie.Value)
		}
		return strings.Join(parts, "; ")
	}
	csrfCookie := cookies(csrfResponse.Result().Cookies())
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/users/login", strings.NewReader(`{"handle":"default-user","password":""}`))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("X-CSRF-Token", csrf.Token)
	loginRequest.Header.Set("Cookie", csrfCookie)
	loginResponse := serve(loginRequest)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d: %s", loginResponse.Code, loginResponse.Body.String())
	}
	return handler, cookies(loginResponse.Result().Cookies()), csrf.Token
}

// a19ProjectedCharacters projects the listing exactly as serveCharactersAll does, so the test compares the
// ROUTE's response against the reference writer over the same nodes.
func a19ProjectedCharacters(t *testing.T, dataRoot string) []orderedNodeJSON {
	t.Helper()
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatalf("resolve user directories: %v", err)
	}
	entries, err := os.ReadDir(directories["characters"])
	if err != nil {
		t.Fatalf("read characters: %v", err)
	}
	characters := make([]orderedNodeJSON, 0, len(entries))
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".png") {
			continue
		}
		character := processCharacterForDirEntry(entry, directories, false, nil)
		if jsTruthy(nodeGet(character, "name")) {
			characters = append(characters, character)
		}
	}
	return characters
}

func TestA19CharactersAllResponseBytesMatchReferenceForGeneratedLibraries(t *testing.T) {
	scales := []struct {
		name  string
		cards int
	}{
		{"cards_1", 1},
		{"cards_100", 100},
		{"cards_1000", 1000},
		{"cards_10000", 10000},
	}
	for _, scale := range scales {
		scale := scale
		t.Run(scale.name, func(t *testing.T) {
			handler, dataRoot, cookie, token := a19PinEnvironment(t, scale.cards)
			request := httptest.NewRequest(http.MethodPost, "/api/characters/all", strings.NewReader(`{}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-CSRF-Token", token)
			request.Header.Set("Cookie", cookie)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("POST /api/characters/all = %d: %s", recorder.Code, recorder.Body.String())
			}
			responseBytes := recorder.Body.Bytes()

			characters := a19ProjectedCharacters(t, dataRoot)
			if len(characters) != scale.cards {
				t.Fatalf("projected %d characters, want %d", len(characters), scale.cards)
			}
			// The route's response must equal the PRODUCTION writer over the same nodes (a shift here means the
			// route assembled different bytes than the marshal implies) and the REFERENCE pre-change writer.
			production, err := marshalCharacterJSON(nodeArray(characters...))
			if err != nil {
				t.Fatalf("marshal production: %v", err)
			}
			if !bytes.Equal(production, responseBytes) {
				t.Fatalf("route response differs from the production marshal of the projected nodes: %s", a19FirstDifference(responseBytes, production))
			}
			reference, err := a19ReferenceMarshalCharacterJSON(nodeArray(characters...))
			if err != nil {
				t.Fatalf("marshal reference: %v", err)
			}
			if !bytes.Equal(reference, responseBytes) {
				t.Fatalf("route response differs from the PRE-CHANGE reference implementation: %s", a19FirstDifference(responseBytes, reference))
			}
			if len(responseBytes) == 0 {
				t.Fatalf("route answered an empty body; a byte-equality assertion on nothing is vacuous")
			}
		})
	}
}

// --- 4. C5: the generic JSON string escaper shares the pinned character-domain escaper ---------------------------

// a19ReferenceMarshalNodeJSONStringEncoder is the PRE-CHANGE implementation of marshalNodeJSONString: an
// encoding/json v2 encoder with SetEscapeHTML(false), then two bytes.ReplaceAll passes that un-escape
// U+2028/U+2029 because JSON.stringify emits them raw. It lives in this test file so the differential test still
// compares the production escaper against an ENCODER, not against itself (C5 makes the production function a
// direct writer; a test that compared it with itself could never fail).
func a19ReferenceMarshalNodeJSONStringEncoder(value string) ([]byte, error) {
	encoded, err := marshalNodeJSON(value)
	if err != nil {
		return nil, err
	}
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2028`), []byte("\u2028"))
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2029`), []byte("\u2029"))
	return encoded, nil
}

// a19EscaperTortureStrings adds the cases the generic path sees that the alpha.18 character corpus already covers
// plus the ones this lane must name explicitly. characterJSONStringCorpus (characters_scale_optimization_test.go)
// supplies every C0 control byte, invalid UTF-8 bytes and a generated mixed stream.
func a19EscaperTortureStrings() []string {
	corpus := append([]string{}, characterJSONStringCorpus()...)
	corpus = append(corpus,
		`{"quoted":"a\"b","backslash":"a\\b","html":"<&>","newline":"a\nb"}`,
		"lone-high-surrogate:\uFFFD", string([]byte{0xED, 0xA0, 0x80}), string([]byte{0xED, 0xBF, 0xBF}),
		"line\u2028separator\u2029paragraph", "日本語テキスト", "😀🚀", "emoji😀in😀keys",
		strings.Repeat("quote\"and\\backslash\n", 500), strings.Repeat("😀", 200), strings.Repeat("a", 4096),
	)
	return corpus
}

// TestA19GenericEscaperMatchesEncoderReference is the C5 byte-identity proof: the production
// marshalNodeJSONString (now the direct, append-based escaper) must equal the pre-change encoding/json encoder
// output for every torture string, including invalid UTF-8, lone surrogates, U+2028/U+2029, CJK, emoji, HTML
// characters and quote/backslash/control-heavy documents.
func TestA19GenericEscaperMatchesEncoderReference(t *testing.T) {
	for index, input := range a19EscaperTortureStrings() {
		reference, err := a19ReferenceMarshalNodeJSONStringEncoder(input)
		if err != nil {
			t.Fatalf("string %d: reference encoder: %v", index, err)
		}
		production, err := marshalNodeJSONString(input)
		if err != nil {
			t.Fatalf("string %d: marshalNodeJSONString: %v", index, err)
		}
		if !bytes.Equal(production, reference) {
			t.Fatalf("string %d (%q): marshalNodeJSONString differs from the encoder reference: %s",
				index, firstN(input, 80), a19FirstDifference(production, reference))
		}
	}
}

// --- 5. C3: one chats-root listing per request, with the error classification preserved --------------------------

// TestA19ChatListingMatchesPerCardReads proves the single-listing fast path in calculateChatSizeForRequest emits
// the same bytes as the pre-change per-card os.ReadDir, over a tree that exercises every branch:
//   - cards 0/1 have real chat directories with two JSONL files each (chat_size and date_last_chat must be the
//     same sums/maxima as the per-card path);
//   - card 2's chats entry is a FILE: the old per-card path's classification of that input is platform-dependent
//     (Windows maps the failed open to ErrNotExist and keeps the card at chat_size 0,0; Linux answers ENOTDIR and
//     the route's error object), so the test pins EQUALITY with the per-card path on this host rather than a count;
//   - card 3 has a differently-cased directory, which Windows resolves and Linux does not: a name MISS is not
//     proof of absence, so the fallback must decide exactly as the old code did on THIS host;
//   - cards 4..9 have no chat directory, the case the fast path exists to answer without a syscall.
//
// The assertion is byte equality between (a) the route's response, (b) the projection through the listing and
// (c) the projection through the old per-card path, plus the specific classified values.
func TestA19ChatListingMatchesPerCardReads(t *testing.T) {
	dataRoot := t.TempDir()
	charactersRoot := filepath.Join(dataRoot, "default-user", "characters")
	chatsRoot := filepath.Join(dataRoot, "default-user", "chats")
	if err := os.MkdirAll(charactersRoot, 0o755); err != nil {
		t.Fatalf("characters root: %v", err)
	}
	if err := os.MkdirAll(chatsRoot, 0o755); err != nil {
		t.Fatalf("chats root: %v", err)
	}
	const cards = 10
	card := a19PinCardPNG(0)
	for index := 0; index < cards; index++ {
		name := fmt.Sprintf("Pin Card %05d.png", index)
		if err := os.WriteFile(filepath.Join(charactersRoot, name), card, 0o644); err != nil {
			t.Fatalf("write card %s: %v", name, err)
		}
	}
	baseTime := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	var expectedChatSize float64
	for _, index := range []int{0, 1} {
		directory := filepath.Join(chatsRoot, fmt.Sprintf("Pin Card %05d", index))
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatalf("create chat directory: %v", err)
		}
		for fileIndex := 0; fileIndex < 2; fileIndex++ {
			path := filepath.Join(directory, fmt.Sprintf("chat-%d.jsonl", fileIndex))
			body := []byte(fmt.Sprintf("{\"user_name\":\"u\"}\n{\"name\":\"Pin\",\"is_user\":false,\"mes\":\"m%d\"}\n", fileIndex))
			if err := os.WriteFile(path, body, 0o644); err != nil {
				t.Fatalf("write chat file: %v", err)
			}
			mtime := baseTime.Add(time.Duration(fileIndex) * time.Minute)
			if err := os.Chtimes(path, mtime, mtime); err != nil {
				t.Fatalf("set chat mtime: %v", err)
			}
			if index == 0 {
				expectedChatSize += float64(len(body))
			}
		}
	}
	// A FILE where a chat directory would be: the old per-card ReadDir fails with ENOTDIR.
	if err := os.WriteFile(filepath.Join(chatsRoot, "Pin Card 00002"), []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("write non-directory chats entry: %v", err)
	}
	// A differently-cased directory: resolved on Windows, absent on Linux; both must match the old behaviour.
	if err := os.MkdirAll(filepath.Join(chatsRoot, "pin card 00003"), 0o755); err != nil {
		t.Fatalf("create case-variant chat directory: %v", err)
	}

	handler, cookie, token := a19PinAuthenticatedHandler(t, dataRoot)
	request := httptest.NewRequest(http.MethodPost, "/api/characters/all", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", token)
	request.Header.Set("Cookie", cookie)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("POST /api/characters/all = %d: %s", recorder.Code, recorder.Body.String())
	}
	responseBytes := recorder.Body.Bytes()

	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatalf("resolve user directories: %v", err)
	}
	entries, err := os.ReadDir(directories["characters"])
	if err != nil {
		t.Fatalf("read characters: %v", err)
	}
	listing := readChatRootListing(directories["chats"])
	if !listing.ok {
		t.Fatal("the chats-root listing failed on a tree that has a chats root; the fast path would fall back for every card")
	}
	withListing := make([]orderedNodeJSON, 0, len(entries))
	perCard := make([]orderedNodeJSON, 0, len(entries))
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".png") {
			continue
		}
		fast := processCharacterForDirEntry(entry, directories, false, listing)
		reference := processCharacterForDirEntry(entry, directories, false, nil)
		if jsTruthy(nodeGet(fast, "name")) {
			withListing = append(withListing, fast)
		}
		if jsTruthy(nodeGet(reference, "name")) {
			perCard = append(perCard, reference)
		}
		if !bytes.Equal(mustMarshalNodeJSON(t, fast), mustMarshalNodeJSON(t, reference)) {
			t.Fatalf("projection through the chats listing differs from the per-card path for %s", entry.Name())
		}
	}
	fastBytes, err := marshalCharacterJSON(nodeArray(withListing...))
	if err != nil {
		t.Fatalf("marshal listing projection: %v", err)
	}
	referenceBytes, err := marshalCharacterJSON(nodeArray(perCard...))
	if err != nil {
		t.Fatalf("marshal per-card projection: %v", err)
	}
	if !bytes.Equal(fastBytes, referenceBytes) {
		t.Fatalf("listing response differs from the per-card response: %s", a19FirstDifference(fastBytes, referenceBytes))
	}
	if !bytes.Equal(fastBytes, responseBytes) {
		t.Fatalf("route response differs from the listing projection: %s", a19FirstDifference(responseBytes, fastBytes))
	}
	// Card 2's chats entry is a FILE. The OLD per-card path's classification of that input is platform-dependent:
	// on Windows os.ReadDir(file) reports "cannot find the path specified", which maps to ErrNotExist, so the old
	// code answers chat_size 0,0 and KEEPS the card; on Linux the same call is ENOTDIR, which the old code answers
	// with the route's error object and the card is dropped. The contract pinned here is therefore not a hard-coded
	// count but EQUALITY with the per-card path on THIS host -- a change that skipped the fallback and answered
	// 0,0 straight from the listing would pass on Windows and fail on Linux, which is exactly where the fallback is
	// load-bearing.
	if len(withListing) != len(perCard) {
		t.Fatalf("listing returned %d characters, per-card path returned %d: the non-directory chats entry was classified differently", len(withListing), len(perCard))
	}
	// The values the listing path must preserve (not just the bytes).
	for _, character := range withListing {
		avatar, _ := nodeGet(character, "avatar").stringValue()
		chatSize, _ := nodeGet(character, "chat_size").scalar.(float64)
		dateLastChat, _ := nodeGet(character, "date_last_chat").scalar.(float64)
		switch avatar {
		case "Pin Card 00000.png":
			if chatSize != expectedChatSize {
				t.Fatalf("card 0 chat_size = %v, want %v", chatSize, expectedChatSize)
			}
			wantLast := float64(baseTime.Add(time.Minute).UnixNano()) / 1e6
			if dateLastChat != wantLast {
				t.Fatalf("card 0 date_last_chat = %v, want %v", dateLastChat, wantLast)
			}
		case "Pin Card 00004.png":
			if chatSize != 0 || dateLastChat != 0 {
				t.Fatalf("card 4 has no chat directory, got chat_size=%v date_last_chat=%v, want 0,0", chatSize, dateLastChat)
			}
		}
	}
}

// TestA19ChatListingFallsBackWhenTheChatsRootCannotBeListed pins the OTHER fallback branch: when the chats root
// itself cannot be listed (here it is a FILE), the request must behave EXACTLY as the old per-card path did, which
// is what answering from a failed listing would break. The observable is again equality with the per-card
// projection, not a hard-coded response.
func TestA19ChatListingFallsBackWhenTheChatsRootCannotBeListed(t *testing.T) {
	dataRoot := t.TempDir()
	charactersRoot := filepath.Join(dataRoot, "default-user", "characters")
	if err := os.MkdirAll(charactersRoot, 0o755); err != nil {
		t.Fatalf("characters root: %v", err)
	}
	for index := 0; index < 3; index++ {
		name := fmt.Sprintf("Pin Card %05d.png", index)
		if err := os.WriteFile(filepath.Join(charactersRoot, name), a19PinCardPNG(0), 0o644); err != nil {
			t.Fatalf("write card %s: %v", name, err)
		}
	}
	// The chats path exists but is a FILE, so os.ReadDir(chatsRoot) fails.
	if err := os.WriteFile(filepath.Join(dataRoot, "default-user", "chats"), []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("write chats root file: %v", err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatalf("resolve user directories: %v", err)
	}
	listing := readChatRootListing(directories["chats"])
	if listing.ok {
		t.Fatal("the chats-root listing reported ok on a non-directory chats path; the fallback would never run")
	}
	entries, err := os.ReadDir(directories["characters"])
	if err != nil {
		t.Fatalf("read characters: %v", err)
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".png") {
			continue
		}
		withListing := processCharacterForDirEntry(entry, directories, false, listing)
		perCard := processCharacterForDirEntry(entry, directories, false, nil)
		if !bytes.Equal(mustMarshalNodeJSON(t, withListing), mustMarshalNodeJSON(t, perCard)) {
			t.Fatalf("with an unlistable chats root the projection differs from the per-card path for %s", entry.Name())
		}
	}
}
