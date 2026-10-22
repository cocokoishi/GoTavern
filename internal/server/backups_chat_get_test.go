package server

// Replay of the pinned chat-backup listing route: POST /api/backups/chat/get (src/endpoints/backups.js:9).
//
// The oracle is tests/oracle/sillytavern-1.19.0-backups-chat-get.json, recorded by
// tools/probe-backups-chat-get.mjs from the pinned server with node-fetch AND the global fetch
// replaced by a controlled peer, so the probe asserts ZERO outbound requests after every step. This
// replay asserts the observable half: the response and the seeded tree.
//
// The steps are ORDERED DATA, iterated in recorded order, because the listings exist to observe the
// deletions before them (AGENTS rule 16). A fixture whose steps are grouped by name instead of
// ordered would desynchronise every later tree snapshot and pass while asserting nothing.
//
// Compared per step: the status, EVERY response header (the raw-byte ETag excepted where the fixture
// classifies it shape), the response bytes (exact text for the 500 and the empty listing, and for a
// listing: the parsed array sorted by file_name plus the byte length), the KEY ORDER of every
// listing object, and the whole backups tree (relative path, kind, size, SHA-256).
//
// The one `shape` field is the raw-byte ETag of a listing: the pinned body is assembled in readdir
// order, which differs between NTFS and ext4, so the fixture records the sorted set and classifies
// the ETag shape with no value. Its PRESENCE is still asserted.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

type chatGetFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret      string            `json:"cookieSecret"`
		Account           sdFixtureAccount  `json:"account"`
		FixedMtimeSeconds int64             `json:"fixedMtimeSeconds"`
		Seed              map[string]string `json:"seed"`
		SeedDirectories   []string          `json:"seedDirectories"`
	} `json:"inputs"`
	Steps            []chatGetStep    `json:"steps"`
	KnownDifferences []map[string]any `json:"knownDifferences"`
}

type chatGetStep struct {
	Name     string          `json:"name"`
	Route    string          `json:"route"`
	Body     json.RawMessage `json:"body"`
	Prepare  *string         `json:"prepare"`
	Response struct {
		Status         int                 `json:"status"`
		Headers        map[string]string   `json:"headers"`
		Body           json.RawMessage     `json:"body"`
		BodyText       *string             `json:"bodyText"`
		BodyLength     int                 `json:"bodyLength"`
		KeyOrderByName map[string][]string `json:"keyOrderByName"`
		Comparison     struct {
			Compared    []string          `json:"compared"`
			Shape       []string          `json:"shape"`
			ShapeReason map[string]string `json:"shapeReason"`
		} `json:"comparison"`
	} `json:"response"`
	State struct {
		Backups []userDataEntry `json:"backups"`
	} `json:"state"`
}

func TestPinnedNodeBackupsChatGet(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-backups-chat-get.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture chatGetFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("baseline = %+v", fixture.Baseline)
	}
	verifyChatGetFixtureShape(t, fixture)

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, installRoot, fixture.Inputs.CookieSecret, fixture.Inputs.Account)
	seedChatGetTree(t, dataRoot, fixture)

	for _, step := range fixture.Steps {
		if step.Prepare != nil {
			applyChatGetPreparation(t, *step.Prepare, dataRoot)
		}
		body := "{}"
		if len(step.Body) > 0 {
			body = string(step.Body)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/backups/chat/"+step.Route, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		if recorder.Code != step.Response.Status {
			t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", step.Name, recorder.Code, step.Response.Status, recorder.Body.String())
		}
		compareChatGetHeaders(t, step, recorder)
		compareChatGetBody(t, step, recorder)

		snapshot := snapshotUserDataTree(t, userRootPath(dataRoot), "backups")["backups"]
		compareUserDataTree(t, step.Name+"/backups", step.State.Backups, snapshot)
	}

	// The dependency the ordered steps exist for: a deletion recorded by the fixture must be visible
	// in the NEXT listing, otherwise the two listings could both be a constant.
	verifyChatGetListingTracksDeletes(t, fixture)
}

// applyChatGetPreparation performs the tree precondition a step declares. It is a closed set: an
// unknown preparation name FAILS rather than being skipped, so a fixture that needs one the replay
// does not implement cannot pass by ignoring it.
func applyChatGetPreparation(t *testing.T, name, dataRoot string) {
	t.Helper()
	switch name {
	case "remove-backups-directory":
		if err := os.RemoveAll(filepath.Join(userRootPath(dataRoot), "backups")); err != nil {
			t.Fatalf("removing the backups directory: %v", err)
		}
	default:
		t.Fatalf("unknown step preparation %q", name)
	}
}

// verifyChatGetFixtureShape refuses to run a suite that cannot discriminate: the fixture must carry
// the four branches this route has (a dense listing, a shorter listing after a delete, an empty
// listing, and the 500 for a missing directory), and it must classify the ETag shape only where it
// actually is order-dependent.
func verifyChatGetFixtureShape(t *testing.T, fixture chatGetFixture) {
	t.Helper()
	if len(fixture.Steps) < 11 {
		t.Fatalf("the fixture records %d steps; the route's listing, deletion and failure branches are not all covered", len(fixture.Steps))
	}
	listings, empties, statuses := 0, 0, map[int]int{}
	for _, step := range fixture.Steps {
		statuses[step.Response.Status]++
		if len(step.Response.Body) > 0 && string(step.Response.Body) != "null" {
			var values []map[string]any
			if err := json.Unmarshal(step.Response.Body, &values); err == nil {
				listings++
				if len(values) == 0 {
					empties++
				}
			}
		}
		// A shape-classified ETag must record no value, and a compared one must.
		shapeEtag := false
		for _, key := range step.Response.Comparison.Shape {
			if strings.TrimSpace(step.Response.Comparison.ShapeReason[key]) == "" {
				t.Fatalf("%s: shape field %q has no reason", step.Name, key)
			}
			if key == "etag" {
				shapeEtag = true
			}
		}
		if shapeEtag {
			if _, recorded := step.Response.Headers["etag"]; recorded {
				t.Fatalf("%s: the ETag is shape-classified but records a value", step.Name)
			}
		}
		if step.Response.BodyText != nil && step.Response.Body != nil && string(step.Response.Body) != "null" {
			t.Fatalf("%s: the step records both a parsed body and a text body", step.Name)
		}
	}
	if listings < 2 {
		t.Fatalf("the fixture records %d listings; at least two are needed to show the route tracks the tree", listings)
	}
	if empties == 0 {
		t.Fatal("the fixture never records an empty listing")
	}
	if statuses[200] == 0 || statuses[500] == 0 {
		t.Fatalf("statuses = %v; the 200 and the 500 branches must both be recorded", statuses)
	}
}

// seedChatGetTree builds exactly the tree the probe seeded, including the fixed mtimes: `last_mes`
// is derived from them, so a replay that let them default to "now" would compare against nothing.
func seedChatGetTree(t *testing.T, dataRoot string, fixture chatGetFixture) {
	t.Helper()
	// Pinned startup leaves a backups/_sysprompt directory; it is baseline state, not a route
	// effect, so the replay seeds it to mirror the recorded preconditions.
	if err := os.MkdirAll(filepath.Join(userRootPath(dataRoot), "backups", "_sysprompt"), 0o777); err != nil {
		t.Fatal(err)
	}
	fixed := time.Unix(fixture.Inputs.FixedMtimeSeconds, 0)
	for name, content := range fixture.Inputs.Seed {
		target := filepath.Join(userRootPath(dataRoot), "backups", filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0o666); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(target, fixed, fixed); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range fixture.Inputs.SeedDirectories {
		inside := filepath.Join(userRootPath(dataRoot), "backups", name, "inside.jsonl")
		if err := os.MkdirAll(filepath.Dir(inside), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(inside, []byte("{\"mes\":\"inside\"}\n"), 0o666); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(inside, fixed, fixed); err != nil {
			t.Fatal(err)
		}
	}
}

func compareChatGetHeaders(t *testing.T, step chatGetStep, recorder *httptest.ResponseRecorder) {
	t.Helper()
	excluded := []string{}
	for _, key := range step.Response.Comparison.Shape {
		if key == "etag" {
			// Shape-classified: the value is a raw-byte hash of a readdir-ordered body, so only its
			// PRESENCE is asserted.
			if recorder.Header().Get("ETag") == "" {
				t.Fatalf("%s: the replay sent no ETag although pinned Node did", step.Name)
			}
			excluded = append(excluded, "ETag")
		}
	}
	assertPinnedHeadersExcluding(t, recorder.Header(), step.Response.Headers, excluded...)
}

func compareChatGetBody(t *testing.T, step chatGetStep, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if got := recorder.Body.Len(); got != step.Response.BodyLength {
		t.Fatalf("%s: body length = %d, pinned %d", step.Name, got, step.Response.BodyLength)
	}
	if step.Response.BodyText != nil {
		if got := recorder.Body.String(); got != *step.Response.BodyText {
			t.Fatalf("%s: body = %q, pinned %q", step.Name, got, *step.Response.BodyText)
		}
		return
	}
	want, err := chatGetSortedListing(step.Response.Body)
	if err != nil {
		t.Fatalf("%s: fixture body: %v", step.Name, err)
	}
	got, err := chatGetSortedListing(recorder.Body.Bytes())
	if err != nil {
		t.Fatalf("%s: response is not the pinned JSON listing: %v (body %q)", step.Name, err, recorder.Body.String())
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: listing = %s, pinned %s", step.Name, chatGetDebug(got), chatGetDebug(want))
	}
	// Key ORDER is a property of the pinned object literal and is host-independent, so it is
	// compared rather than normalised away.
	keyOrder := chatGetKeyOrder(t, recorder.Body.Bytes())
	if !reflect.DeepEqual(keyOrder, step.Response.KeyOrderByName) {
		t.Fatalf("%s: object key order = %v, pinned %v", step.Name, keyOrder, step.Response.KeyOrderByName)
	}
}

// chatGetSortedListing decodes a listing into comparable maps (numbers kept verbatim) sorted by
// file_name, which is the same normalisation the probe applies to the readdir-ordered body.
func chatGetSortedListing(raw []byte) ([]map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var values []map[string]any
	if err := decoder.Decode(&values); err != nil {
		return nil, err
	}
	if values == nil {
		return nil, fmt.Errorf("not a JSON array")
	}
	sort.SliceStable(values, func(left, right int) bool {
		return fmt.Sprint(values[left]["file_name"]) < fmt.Sprint(values[right]["file_name"])
	})
	return values, nil
}

func chatGetDebug(values []map[string]any) string {
	encoded, _ := json.Marshal(values)
	return string(encoded)
}

// chatGetKeyOrder reads, for every object in the top-level array, its key sequence in wire order. A
// canonical re-encoding sorts keys, so a map comparison would lose exactly the property being
// asserted (the pinned object literal's insertion order).
func chatGetKeyOrder(t *testing.T, raw []byte) map[string][]string {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if token, err := decoder.Token(); err != nil || token != json.Delim('[') {
		t.Fatalf("listing does not start with an array")
	}
	result := map[string][]string{}
	for decoder.More() {
		if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
			t.Fatalf("listing entry does not start with an object")
		}
		keys := []string{}
		name := ""
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				t.Fatalf("reading a key: %v", err)
			}
			key := fmt.Sprint(keyToken)
			keys = append(keys, key)
			var value any
			if err := decoder.Decode(&value); err != nil {
				t.Fatalf("reading %q's value: %v", key, err)
			}
			if key == "file_name" {
				name = fmt.Sprint(value)
			}
		}
		if _, err := decoder.Token(); err != nil {
			t.Fatalf("closing an object: %v", err)
		}
		if len(keys) == 0 {
			t.Fatalf("an entry has no keys")
		}
		result[name] = keys
	}
	return result
}

// verifyChatGetListingTracksDeletes proves the ordered steps are dependent data: every recorded
// deletion must remove exactly one path from the next snapshot, and the listing after it must be
// smaller. Without this the whole tree could be a constant and the two listings indistinguishable.
func verifyChatGetListingTracksDeletes(t *testing.T, fixture chatGetFixture) {
	t.Helper()
	previous := map[string]bool{}
	deletions := 0
	previousListing := -1
	for _, step := range fixture.Steps {
		current := map[string]bool{}
		for _, entry := range step.State.Backups {
			current[entry.Path] = true
		}
		if previous != nil {
			for path := range previous {
				if !current[path] {
					deletions++
				}
			}
		}
		previous = current
		var values []map[string]any
		if len(step.Response.Body) > 0 && string(step.Response.Body) != "null" && json.Unmarshal(step.Response.Body, &values) == nil {
			if previousListing >= 0 && step.Route == "get" && previousListing > 0 && len(values) > previousListing {
				t.Fatalf("%s: the listing GREW from %d to %d entries after deletions", step.Name, previousListing, len(values))
			}
			previousListing = len(values)
		}
	}
	if deletions == 0 {
		t.Fatal("the fixture never records a deletion, so the listing assertions cannot fail")
	}
}
