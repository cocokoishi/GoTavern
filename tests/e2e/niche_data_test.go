package e2e

// NICHE DATA EXTREMES (alpha.17; domain IDs DATA-001..DATA-009).
//
// JSON and JSONL shapes a real user's tree produces: a zero-byte or whitespace-only autosave, a BOM from an
// editor, CRLF lines from a Windows tool, a chat whose last line was cut by a crash, duplicate keys, values
// at JavaScript's numeric precision boundary, deep nesting, a megabyte string, and a reader racing a writer.
//
// The chat JSONL expectations are SOURCE-DERIVED from pinned's own reader, not invented: chats.js
// getChatData() splits on '\n', JSON.parse each line in tryParse and `.filter(x => x)`, so a malformed,
// blank, null, false, 0 or empty-string line disappears while [], {} and 1 survive (verified against
// Node's JSON.parse/truthiness in the probe recorded in the evidence document). The settings expectations
// are pinned by body-parser + JSON.stringify: duplicate keys keep the LAST value, numbers round through
// float64, and 1e400 becomes Infinity BEFORE stringify (a divergence recorded, not fixed, below).
//
// Every comparator is shared with niche_teeth_test.go.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// DATA-001: a zero-byte and a whitespace-only settings autosave are refused (400) and the PREVIOUS document
// survives. Pinned's settings save handler stringifies request.body; body-parser leaves {} for an empty
// body, so GoTavern's explicit 400 for an empty/whitespace body is the recorded product contract here and
// the data-loss half is what this case asserts: a refused save must not truncate the file.
func TestNicheDataZeroByteAndWhitespaceSettingsAreRefusedWithoutLoss(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	document := `{"marker":"NICHE-DATA-001-SURVIVES"}`
	if status, body := nicheSaveSettings(t, booted.client, document); status != 200 {
		t.Fatalf("settings/save control = %d: %s", status, truncateForLog(body, 200))
	}
	before := nicheSettingsDocument(t, tree)
	for _, empty := range []string{"", "   \n\t  \r\n "} {
		status, body := nicheSaveSettings(t, booted.client, empty)
		if err := nicheCheckStatus("settings/save "+scrubForLog(empty), status, 400); err != nil {
			t.Fatalf("%v (body %s)", err, truncateForLog(body, 160))
		}
		if after := nicheSettingsDocument(t, tree); after != before {
			t.Fatalf("a refused empty save CHANGED settings.json:\n  before %s\n  after  %s",
				truncateForLog(before, 160), truncateForLog(after, 160))
		}
	}
	if served := nicheSettingsServed(t, booted.client); !strings.Contains(served, "NICHE-DATA-001-SURVIVES") {
		t.Fatalf("the previous document is no longer served: %s", truncateForLog(served, 200))
	}
}

// DATA-002: a BOM-prefixed settings BODY is refused (pinned JSON.parse rejects U+FEFF, so body-parser
// answers 400), while a BOM that is already ON DISK is served raw: the route reads the file text and puts it
// in the `settings` string, so the frontend receives the same bytes the user's editor wrote.
func TestNicheDataBOMSettingsBodyRefusedAndOnDiskBOMPreserved(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	control := `{"marker":"NICHE-DATA-002-CONTROL"}`
	if status, _ := nicheSaveSettings(t, booted.client, control); status != 200 {
		t.Fatalf("settings/save control = %d", status)
	}
	bomBody := "\uFEFF" + `{"marker":"NICHE-DATA-002-BOM"}`
	status, body := nicheSaveSettings(t, booted.client, bomBody)
	if err := nicheCheckStatus("settings/save BOM body", status, 400); err != nil {
		t.Fatalf("%v (body %s)", err, truncateForLog(body, 200))
	}
	if served := nicheSettingsServed(t, booted.client); !strings.Contains(served, "NICHE-DATA-002-CONTROL") {
		t.Fatalf("the refused BOM save replaced the previous document: %s", truncateForLog(served, 200))
	}

	// ON-DISK BOM: plant the bytes an editor writes, externally, then RELOAD (the settings cache is keyed by
	// mtime+size, so a new file with a new mtime is re-read).
	onDisk := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"marker":"NICHE-DATA-002-DISK"}`)...)
	nicheWriteFile(t, tree.settingsPath(), onDisk)
	if err := os.Chtimes(tree.settingsPath(), nicheFilesystemTime().Add(2e9), nicheFilesystemTime().Add(2e9)); err != nil {
		t.Fatalf("move the planted file's mtime: %v", err)
	}
	served := nicheSettingsServed(t, booted.client)
	if !strings.HasPrefix(served, "\uFEFF") {
		t.Fatalf("the on-disk BOM was not preserved in the served settings string: %q", truncateForLog(served, 120))
	}
	if err := nicheCheckContains("on-disk BOM settings", served, "NICHE-DATA-002-DISK"); err != nil {
		t.Fatalf("%v", err)
	}
}

// nicheFilesystemTime returns a time comfortably in the future so a planted file's identity always changes.
func nicheFilesystemTime() time.Time { return time.Now().Add(2 * time.Hour) }

// DATA-003: DUPLICATE JSON KEYS. body-parser's JSON.parse keeps the LAST value and JSON.stringify re-emits
// one member, so the saved document must carry "second" and must not carry "first".
func TestNicheDataDuplicateJSONKeysLastValueWins(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	if status, body := nicheSaveSettings(t, booted.client, `{"dup":"first","dup":"NICHE-DATA-003-SECOND"}`); status != 200 {
		t.Fatalf("settings/save duplicate keys = %d: %s", status, truncateForLog(body, 200))
	}
	served := nicheSettingsServed(t, booted.client)
	if err := nicheCheckSettingsValue("duplicate keys", served, "dup", "NICHE-DATA-003-SECOND"); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckNotContains("duplicate keys", served, "first"); err != nil {
		t.Fatalf("%v", err)
	}
}

// DATA-004: null / false / 0 / "" / [] round-trip unchanged. A "falsy means absent" shortcut would drop
// them, which changes a user's saved settings.
func TestNicheDataNullFalseZeroSettingsRoundTrip(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	document := `{"a":null,"b":false,"c":0,"d":"","e":[],"f":{}}`
	if status, body := nicheSaveSettings(t, booted.client, document); status != 200 {
		t.Fatalf("settings/save falsy members = %d: %s", status, truncateForLog(body, 200))
	}
	served := nicheSettingsServed(t, booted.client)
	for member, want := range map[string]string{
		"a": "null",
		"b": "false",
		"c": "0",
		"d": `""`,
		"e": "[]",
		"f": "{}",
	} {
		if err := nicheCheckMember("falsy round-trip", served, member, want); err != nil {
			t.Fatalf("%v", err)
		}
	}
}

// DATA-005: numbers at JavaScript's boundary. JSON.parse rounds 9007199254740993 to 9007199254740992
// (float64) and JSON.stringify re-emits the rounded value; a high-precision decimal loses digits the same
// way. The test therefore asserts the JAVASCRIPT observable, not exact decimal preservation.
func TestNicheDataHugeIntegersAndFloatsFollowJavaScriptSemantics(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	document := `{"big":9007199254740993,"precision":1.234567890123456789}`
	if status, body := nicheSaveSettings(t, booted.client, document); status != 200 {
		t.Fatalf("settings/save big numbers = %d: %s", status, truncateForLog(body, 200))
	}
	served := nicheSettingsServed(t, booted.client)
	if err := nicheCheckMember("big integer", served, "big", "9007199254740992"); err != nil {
		t.Fatalf("%v: a JSON number at the float64 precision boundary must be re-emitted with JavaScript's rounding", err)
	}
	if err := nicheCheckMember("float precision", served, "precision", "1.2345678901234567"); err != nil {
		t.Fatalf("%v", err)
	}
}

// DATA-006: DEEP NESTING. 1000 levels is accepted and preserved; 10000 levels is refused (400) and the
// previous document survives. Pinned's JSON.parse accepts 10000 levels and JSON.stringify then throws
// RangeError (measured with Node in the evidence document), so both implementations refuse this shape --
// GoTavern at parse time, pinned at stringify time. The pinned status is not captured, so this case pins
// the Go status and asserts the data-safety half.
func TestNicheDataDeepNestingPreservedAt1000AndRefusedAt10000(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	nested := func(depth int) string {
		return `{"deep":` + strings.Repeat("[", depth) + `0` + strings.Repeat("]", depth) + `}`
	}
	if status, body := nicheSaveSettings(t, booted.client, nested(1000)); status != 200 {
		t.Fatalf("settings/save depth 1000 = %d: %s", status, truncateForLog(body, 200))
	}
	before := nicheSettingsDocument(t, tree)
	if !strings.Contains(before, `[`) {
		t.Fatalf("the depth-1000 document was not stored: %s", truncateForLog(before, 160))
	}
	if status, body := nicheSaveSettings(t, booted.client, nested(10000)); status != 400 {
		t.Fatalf("settings/save depth 10000 = %d (want the 400 parser refusal): %s", status, truncateForLog(body, 200))
	}
	if after := nicheSettingsDocument(t, tree); after != before {
		t.Fatalf("a refused deep document CHANGED settings.json")
	}
}

// DATA-007: a 1 MiB string and an unknown nested object survive the product's parse+stringify round-trip
// byte-identically (the expectation is the route's own normalised document, so no second serializer is
// involved).
func TestNicheDataHugeStringAndUnknownFieldsSurvive(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	huge := strings.Repeat("h", 1<<20)
	document := `{"huge":"` + huge + `","unknown":{"nested":[1,2,{"deep":true}]}}`
	if status, body := nicheSaveSettings(t, booted.client, document); status != 200 {
		t.Fatalf("settings/save 1MiB string = %d: %s", status, truncateForLog(body, 200))
	}
	served := nicheSettingsServed(t, booted.client)
	var decoded struct {
		Huge    string          `json:"huge"`
		Unknown json.RawMessage `json:"unknown"`
	}
	if err := json.Unmarshal([]byte(served), &decoded); err != nil {
		t.Fatalf("served settings are not JSON: %v", err)
	}
	if len(decoded.Huge) != len(huge) {
		t.Fatalf("the huge string came back with %d bytes, want %d", len(decoded.Huge), len(huge))
	}
	if string(decoded.Huge) != huge {
		t.Fatalf("the huge string's bytes changed across the round-trip")
	}
	if err := nicheCheckMember("unknown nested object", served, "unknown", `{"nested":[1,2,{"deep":true}]}`); err != nil {
		t.Fatalf("%v", err)
	}
}

// DATA-008: planted chat JSONL edge shapes, read through /api/chats/get. Each expectation is derived from
// pinned chats.js getChatData() (split on '\n', JSON.parse each line, keep truthy values) and was verified
// against Node's own JSON.parse/truthiness in the evidence document.
func TestNicheDataChatJSONLEdgeLines(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	avatar := "JsonlCard.png"
	directory := tree.chatDir(avatar)
	if err := os.MkdirAll(directory, 0o777); err != nil {
		t.Fatalf("create the chat directory: %v", err)
	}
	write := func(name string, body []byte) {
		nicheWriteFile(t, filepath.Join(directory, name+".jsonl"), body)
	}
	cases := []struct {
		name string
		body []byte
		want string
	}{
		{"crlf", []byte(`{"mes":"a"}` + "\r\n" + `{"mes":"b"}` + "\r\n"), `[{"mes":"a"},{"mes":"b"}]`},
		{"no-final-newline", []byte(`{"mes":"a"}` + "\n" + `{"mes":"b"}`), `[{"mes":"a"},{"mes":"b"}]`},
		{"empty-line-middle", []byte(`{"mes":"a"}` + "\n\n" + `{"mes":"b"}` + "\n"), `[{"mes":"a"},{"mes":"b"}]`},
		// A truncated final line is DROPPED by the pinned reader; the valid prefix is preserved. This pins
		// the recovery behaviour instead of inventing a repair.
		{"truncated-final-line", []byte(`{"mes":"a"}` + "\n" + `{"mes":"b"}` + "\n" + `{"mes":"half`), `[{"mes":"a"},{"mes":"b"}]`},
		// A BOM makes the FIRST line unparseable (JSON.parse rejects U+FEFF), so only the second survives.
		{"bom-first-line", append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"mes":"bomfirst"}`+"\n"+`{"mes":"second"}`)...), `[{"mes":"second"}]`},
		{"duplicate-keys", []byte(`{"mes":"first","mes":"second"}` + "\n"), `[{"mes":"second"}]`},
		// JS truthiness: 0, false, null, "" and a blank line are filtered; [], {}, 1 and a non-empty string
		// are kept.
		{"falsy-lines", []byte("0\nfalse\nnull\n\"\"\n\n[]\n{}\n1\n\"str\"\n"), `[[],{},1,"str"]`},
		{"zero-byte", []byte{}, `[]`},
	}
	for _, scenario := range cases {
		write(scenario.name, scenario.body)
		status, body := nicheGetChat(t, booted.client, avatar, scenario.name)
		if err := nicheCheckStatus("chats/get "+scenario.name, status, 200); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckBody("chats/get "+scenario.name, body, scenario.want); err != nil {
			t.Fatalf("%v", err)
		}
	}
	// The files the product WROTE itself (a save) are the ones whose JSONL must be fully valid; the planted
	// BOM file above is deliberately invalid on its first line.
	if status, body := nicheSaveChat(t, booted.client, avatar, "product-written", []map[string]any{{"mes": "NICHE-DATA-008"}}); status != 200 {
		t.Fatalf("chat save = %d: %s", status, truncateForLog(body, 200))
	}
	if err := nicheCheckJSONLLines("product-written chat", mustReadNicheFile(t, filepath.Join(directory, "product-written.jsonl"))); err != nil {
		t.Fatalf("%v", err)
	}
}

// DATA-009: a reader racing a writer never observes a TORN chat. The writer replaces the whole file through
// the product's atomic publish, so every /api/chats/get response must be exactly the complete old array or
// the complete new one. As in the A15 reader case, a Windows save that loses a sharing race is RECORDED and
// not treated as a product finding; the invariant asserted on every host is the absence of a partial array.
func TestNicheDataConcurrentChatReadWhileWritingIsNeverTorn(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	avatar := "RaceCard.png"
	path := filepath.Join(tree.chatDir(avatar), "race.jsonl")
	makeBody := func(marker string, pad int) []map[string]any {
		return []map[string]any{{"name": "User", "is_user": true, "mes": "NICHE-DATA-009-" + marker + strings.Repeat("x", pad)}}
	}
	if status, body := nicheSaveChat(t, booted.client, avatar, "race", makeBody("A", 64<<10)); status != 200 {
		t.Fatalf("control save A = %d: %s", status, truncateForLog(body, 200))
	}
	expectedA := nicheExpectedChatBody(nicheChatLines(t, path))
	writer := openSession(t, booted.server.origin)
	if status, body := nicheSaveChat(t, writer, avatar, "race", makeBody("B", 64<<10)); status != 200 {
		t.Fatalf("control save B = %d: %s", status, truncateForLog(body, 200))
	}
	expectedB := nicheExpectedChatBody(nicheChatLines(t, path))
	if expectedA == expectedB {
		t.Fatal("the two control bodies are identical, so the torn-read assertion could not discriminate")
	}

	type observation struct {
		mu      sync.Mutex
		reads   int
		sawA    int
		sawB    int
		empty   int
		partial int
		samples []string
	}
	observed := &observation{}
	stop := make(chan struct{})
	var reader sync.WaitGroup
	reader.Add(1)
	go func() {
		defer reader.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			status, body := nicheGetChat(t, booted.client, avatar, "race")
			observed.mu.Lock()
			observed.reads++
			switch {
			case status != 200:
				observed.partial++
				if len(observed.samples) < 3 {
					observed.samples = append(observed.samples, "status "+itoaForTest(status))
				}
			case body == expectedA:
				observed.sawA++
			case body == expectedB:
				observed.sawB++
				// pinned's getChatData turns a READ ERROR into [] (tryReadFileSync(...) ?? ''), so an empty
				// array is not a torn byte sequence; it is the pinned reader's failure fallback. Windows can
				// produce it during a rename-over-open sharing race (the A15 reader case records the same
				// class). It is counted separately and only fails on non-Windows hosts, where rename-over-open
				// cannot fail this way.
			case body == "[]":
				observed.empty++
				if len(observed.samples) < 3 {
					observed.samples = append(observed.samples, "empty-array-read")
				}
			default:
				observed.partial++
				if len(observed.samples) < 3 {
					observed.samples = append(observed.samples, truncateForLog(body, 120))
				}
			}
			observed.mu.Unlock()
		}
	}()
	saveFailures := 0
	for round := 0; round < 8; round++ {
		marker := "A"
		if round%2 == 1 {
			marker = "B"
		}
		status, _ := nicheSaveChat(t, writer, avatar, "race", makeBody(marker, 64<<10))
		if status != 200 {
			saveFailures++
		}
	}
	close(stop)
	reader.Wait()
	observed.mu.Lock()
	reads, sawA, sawB, empty, partial, samples := observed.reads, observed.sawA, observed.sawB, observed.empty, observed.partial, append([]string(nil), observed.samples...)
	observed.mu.Unlock()
	t.Logf("race: reads=%d old=%d new=%d empty-array-reads=%d non-complete=%d saveFailures=%d", reads, sawA, sawB, empty, partial, saveFailures)
	if partial != 0 {
		t.Fatalf("a concurrent reader observed %d non-complete chat response(s), samples: %s; a save must publish old XOR new",
			partial, strings.Join(samples, " | "))
	}
	if empty > 0 {
		if nicheHostIsWindows() {
			t.Logf("HOST FINDING (windows): %d read(s) during the save returned [] because pinned's reader maps a read error to an empty chat; recorded, not treated as a product finding (A15 reader case records the same sharing race)", empty)
		} else {
			t.Fatalf("on %s a concurrent chat read returned [] %d time(s); rename-over-open must not make the reader fail", runtime.GOOS, empty)
		}
	}
	if sawA == 0 || sawB == 0 {
		t.Fatalf("the reader never observed both published documents (old=%d new=%d), so the torn-read assertion would pass vacuously", sawA, sawB)
	}
	if saveFailures > 0 {
		t.Logf("RACE FINDING on this host: %d/8 chat saves failed while a reader was active (the A15 reader case records the same Windows sharing race)", saveFailures)
	}
}
