package server

// Replay of the four pinned data-maid routes against
// tests/oracle/sillytavern-1.19.0-data-maid.json (recorded by tools/probe-data-maid.mjs).
//
// `steps` is an ARRAY and is replayed in order: every step shares one user tree and one
// process-wide token store, so reordering the steps would desynchronise every later snapshot while
// still passing. The fixture is read into a slice, so a re-recorded fixture that turned the list
// into a keyed object cannot even be decoded — the ordering is enforced by the type, not by a
// comment.
//
// The two values that cannot cross a host boundary are handled as CONSEQUENCES, never as recorded
// values:
//
//   - the token appears in requests only as a `<token:STEP>` reference and in the report body only
//     as `<token>`; what it unlocks, what a stale/unknown/cross-handle token answers and the fact
//     that a rejected request does not consume it are all compared per step.
//   - each record hash appears only as `<hash:STEP:CATEGORY:IDENTITY>`. The hash RULE,
//     `sha256(absolute path)`, is asserted by a LABELLED SOURCE-DERIVED test below, because no
//     recorded value for it can be host-independent.
//
// Every step compares the response headers, the body (structure for a report, bytes for
// `/view`), the whole user tree (path, kind, size, sha256) and the recorded outbound count.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type dataMaidFixtureAccount struct {
	Handle   string `json:"handle"`
	Name     string `json:"name"`
	Admin    bool   `json:"admin"`
	Password string `json:"password"`
	Salt     string `json:"salt"`
}

type dataMaidFixtureSeedFile struct {
	Path        string `json:"path"`
	BytesBase64 string `json:"bytesBase64"`
}

type dataMaidFixtureRequest struct {
	Method         string            `json:"method"`
	Route          string            `json:"route"`
	Session        string            `json:"session"`
	Query          map[string]string `json:"query"`
	DuplicateQuery map[string]string `json:"duplicateQuery"`
	Body           json.RawMessage   `json:"body"`
}

type dataMaidFixtureResponse struct {
	Status     int                `json:"status"`
	Headers    map[string]*string `json:"headers"`
	BodyKind   string             `json:"bodyKind"`
	Body       json.RawMessage    `json:"body"`
	BodyBase64 *string            `json:"bodyBase64"`
	BodySha256 *string            `json:"bodySha256"`
	BodyLength *int               `json:"bodyLength"`
}

type dataMaidFixtureStep struct {
	Name        string                  `json:"name"`
	Description string                  `json:"description"`
	Request     dataMaidFixtureRequest  `json:"request"`
	Response    dataMaidFixtureResponse `json:"response"`
	Tree        []userDataEntry         `json:"tree"`
	Outbound    int                     `json:"outbound"`
	Comparison  searchComparison        `json:"comparison"`
}

type dataMaidFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Conventions map[string]string `json:"conventions"`
	Inputs      struct {
		CookieSecret      string                    `json:"cookieSecret"`
		FixedMtimeSeconds int64                     `json:"fixedMtimeSeconds"`
		VolatileTreeFiles []string                  `json:"volatileTreeFiles"`
		Account           dataMaidFixtureAccount    `json:"account"`
		Guest             dataMaidFixtureAccount    `json:"guest"`
		SeedFiles         []dataMaidFixtureSeedFile `json:"seedFiles"`
	} `json:"inputs"`
	Steps []dataMaidFixtureStep `json:"steps"`
}

var dataMaidObservableKeys = []string{"status", "headers", "tree", "outbound"}

func TestPinnedNodeDataMaidRoutes(t *testing.T) {
	fixture := readDataMaidFixture(t)
	verifyDataMaidFixture(t, fixture)

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, fixture.Inputs.Account.Handle)
	handler := newDataMaidHandler(t, dataRoot, installRoot, fixture)
	seedDataMaidTree(t, userRoot, fixture)
	sessions := map[string]dataMaidSession{
		"default": dataMaidLogin(t, handler, fixture.Inputs.Account),
		"guest":   dataMaidLogin(t, handler, fixture.Inputs.Guest),
	}

	state := &dataMaidReplayState{
		tokens:  make(map[string]string),
		reports: make(map[string]map[string][]map[string]any),
	}
	for _, step := range fixture.Steps {
		session, known := sessions[step.Request.Session]
		if !known {
			t.Fatalf("%s: fixture names session %q, which the probe never recorded", step.Name, step.Request.Session)
		}
		request := buildDataMaidRequest(t, step, session, state)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareDataMaidResponse(t, step, recorder)
		compareUserDataTree(t, step.Name, step.Tree, snapshotDataMaidTree(t, userRoot, fixture.Inputs.VolatileTreeFiles))

		if step.Outbound != 0 {
			t.Fatalf("%s: fixture records %d outbound requests; this domain makes none", step.Name, step.Outbound)
		}
		if recorder.Code == http.StatusOK && step.Request.Route == "/api/data-maid/report" {
			var payload struct {
				Report map[string][]map[string]any `json:"report"`
				Token  string                      `json:"token"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("%s: report body is not JSON: %v", step.Name, err)
			}
			state.tokens[step.Name] = payload.Token
			state.reports[step.Name] = payload.Report
			// LABELLED SOURCE-DERIVED TEST (rule 4). The chain is `generateToken` storing
			// {path, sha256(path)} and `/view`, `/finalize` and `/delete` being gated on it. The
			// value cannot be recorded (it contains this host's data root), so the RULE is asserted
			// against the live token store, through the token the response just handed out.
			assertDataMaidTokenPaths(t, step.Name, payload.Token, userRoot)
		}
	}
}

// readDataMaidFixture decodes the recorded fixture. It is an ARRAY of steps on purpose; a fixture
// whose steps became an object fails here rather than being silently reordered.
func readDataMaidFixture(t *testing.T) dataMaidFixture {
	t.Helper()
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-data-maid.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture dataMaidFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("data-maid oracle fixture is not replayable: %v", err)
	}
	return fixture
}

// verifyDataMaidFixture refuses to run unless the fixture can fail. A fixture that lost its
// control cases, its deletions, or its marker discipline would otherwise let every assertion below
// pass without discriminating anything.
func verifyDataMaidFixture(t *testing.T, fixture dataMaidFixture) {
	t.Helper()
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("data-maid oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Steps) == 0 {
		t.Fatal("data-maid oracle has no steps")
	}
	if len(fixture.Inputs.SeedFiles) == 0 {
		t.Fatal("data-maid oracle records no seed files, so the replay has no tree to report on")
	}
	if fixture.Inputs.VolatileTreeFiles == nil {
		t.Fatal("data-maid oracle does not name the tree files to exclude; the exclusion must be recorded, not assumed")
	}
	statuses := make(map[int]int)
	deletions := 0
	seenReportToken := false
	seenReportStructural := false
	hashMarkerSteps := 0
	sawViewBytes := false
	previousTree := map[string]bool{}
	for _, step := range fixture.Steps {
		if step.Name == "" || step.Request.Route == "" || step.Response.Status == 0 {
			t.Fatalf("data-maid oracle step %+v is missing its name, route or status", step)
		}
		classified := make(map[string]bool)
		for _, key := range step.Comparison.Compared {
			classified[key] = true
		}
		for _, key := range step.Comparison.Shape {
			classified[key] = true
			if strings.TrimSpace(step.Comparison.ShapeReason[key]) == "" {
				t.Fatalf("%s: shape field %q has no reason", step.Name, key)
			}
			if key == "status" {
				t.Fatalf("%s: status must never be classified shape", step.Name)
			}
		}
		for _, key := range append(append([]string{}, dataMaidObservableKeys...), dataMaidBodyObservableKeys(step)...) {
			if !classified[key] {
				t.Fatalf("%s: observable %q is neither compared nor shape-classified", step.Name, key)
			}
		}
		statuses[step.Response.Status]++
		currentTree := make(map[string]bool, len(step.Tree))
		for _, entry := range step.Tree {
			if entry.Kind == "file" {
				currentTree[entry.Path] = true
			}
		}
		for existing := range previousTree {
			if !currentTree[existing] {
				deletions++
			}
		}
		previousTree = currentTree

		if step.Response.BodyKind == "json" {
			text := string(step.Response.Body)
			if !strings.Contains(text, `"<token>"`) {
				t.Fatalf("%s: report body does not carry the <token> marker", step.Name)
			}
			// A report with no loose files still has to carry the token marker; only a report that
			// reports something can exercise the hash marker.
			if strings.Contains(text, `"hash"`) {
				if !strings.Contains(text, `"<hash:`) {
					t.Fatalf("%s: report body records a hash that is not a <hash:...> marker", step.Name)
				}
				hashMarkerSteps++
			}
			seenReportToken = true
			if strings.Contains(text, `"parent":`) {
				seenReportStructural = true
			}
		}
		if step.Request.Route == "/api/data-maid/view" && step.Response.Status == 200 && step.Response.BodyBase64 != nil && *step.Response.BodyLength > 0 {
			sawViewBytes = true
		}
	}
	for _, status := range []int{http.StatusOK, http.StatusNoContent, http.StatusBadRequest, http.StatusForbidden, http.StatusNotFound} {
		if statuses[status] == 0 {
			t.Fatalf("data-maid oracle never records a %d, so it cannot discriminate that branch", status)
		}
	}
	if !seenReportToken || !seenReportStructural {
		t.Fatal("data-maid oracle does not record a report body with marker substitution and a parent member")
	}
	if hashMarkerSteps < 3 {
		t.Fatalf("data-maid oracle records <hash:...> markers in only %d report bodies", hashMarkerSteps)
	}
	if !sawViewBytes {
		t.Fatal("data-maid oracle records no successful /view body, so the byte comparison cannot fail")
	}
	if deletions == 0 {
		t.Fatal("data-maid oracle records no deletion, so the tree snapshots cannot fail")
	}

	// No random token may be recorded in a REQUEST or a RESPONSE. The only 64-hex run those may
	// contain is a fabricated literal, which the probe writes as <literal:...>. Tree entries are
	// excluded from the sweep because their sha256 IS a legitimate recorded observable.
	var scan strings.Builder
	for _, step := range fixture.Steps {
		encoded, err := marshalNodeJSON(step.Request)
		if err != nil {
			t.Fatal(err)
		}
		encodedHeaders, err := marshalNodeJSON(step.Response.Headers)
		if err != nil {
			t.Fatal(err)
		}
		scan.Write(encoded)
		scan.Write(encodedHeaders)
		scan.Write(step.Response.Body)
		if step.Response.BodyBase64 != nil {
			scan.WriteString(*step.Response.BodyBase64)
		}
	}
	fixtureText := scan.String()
	for _, run := range dataMaidHexRunPattern.FindAllStringIndex(fixtureText, -1) {
		if !strings.HasSuffix(fixtureText[:run[0]], "<literal:") {
			t.Fatalf("data-maid oracle records a 64-character hex value outside a <literal:...> marker: %q", fixtureText[run[0]:run[1]])
		}
	}
}

var dataMaidHexRunPattern = regexp.MustCompile(`[0-9a-f]{64}`)

func dataMaidBodyObservableKeys(step dataMaidFixtureStep) []string {
	switch step.Response.BodyKind {
	case "json":
		return []string{"body"}
	case "bytes":
		return []string{"bodyBase64", "bodySha256", "bodyLength"}
	default:
		panic("data-maid oracle has a body of unknown kind " + step.Response.BodyKind)
	}
}

func mustReadDataMaidFixture(t *testing.T) []byte {
	t.Helper()
	content, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-data-maid.json"))
	if err != nil {
		t.Fatal(err)
	}
	return content
}

// newDataMaidHandler builds a runtime with the fixture's two accounts, both before the handler is
// constructed because the account runtime loads the store then. Only the default handle's user
// directories are created: the fixture's guest report pins what a handle without directories sees.
func newDataMaidHandler(t *testing.T, dataRoot, installRoot string, fixture dataMaidFixture) http.Handler {
	t.Helper()
	writeDataMaidAccount(t, dataRoot, fixture.Inputs.Account, "")
	guestPassword := ""
	if fixture.Inputs.Guest.Password != "" {
		hash, err := upstreamPasswordHash(fixture.Inputs.Guest.Password, fixture.Inputs.Guest.Salt)
		if err != nil {
			t.Fatal(err)
		}
		guestPassword = hash
	}
	writeDataMaidAccount(t, dataRoot, fixture.Inputs.Guest, guestPassword)
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.EnsureDirectories(installRoot, dataRoot, []string{fixture.Inputs.Account.Handle})
	if err != nil {
		t.Fatal(err)
	}
	if migrationErrors, err := startup.MigrateSystemPrompts(dataRoot, directories); err != nil || len(migrationErrors) != 0 {
		t.Fatalf("initialize data-maid migration state: errors=%v, fatal=%v", migrationErrors, err)
	}
	if statistics := startup.InitializeStatistics(directories, time.UnixMilli(1735689600000)); len(statistics.Errors) != 0 {
		t.Fatalf("initialize data-maid statistics: %v", statistics.Errors)
	}
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
	})
}

func writeDataMaidAccount(t *testing.T, dataRoot string, account dataMaidFixtureAccount, passwordHash string) {
	t.Helper()
	encoded, err := marshalNodeJSON(map[string]any{
		"handle":   account.Handle,
		"name":     account.Name,
		"created":  1700000000000,
		"password": passwordHash,
		"admin":    account.Admin,
		"enabled":  true,
		"salt":     account.Salt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+account.Handle, encoded); err != nil {
		t.Fatal(err)
	}
}

type dataMaidSession struct {
	cookie string
	token  string
}

func dataMaidLogin(t *testing.T, handler http.Handler, account dataMaidFixtureAccount) dataMaidSession {
	t.Helper()
	serve := func(request *http.Request) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	csrf := serve(httptest.NewRequest(http.MethodGet, "/csrf-token", nil))
	if csrf.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d, body %q", csrf.Code, csrf.Body.String())
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrf.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	csrfCookie := joinCookies(csrf.Header().Values("Set-Cookie"))
	body, err := marshalNodeJSON(map[string]string{"handle": account.Handle, "password": account.Password})
	if err != nil {
		t.Fatal(err)
	}
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/users/login", bytes.NewReader(body))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("Cookie", csrfCookie)
	loginRequest.Header.Set("X-CSRF-Token", payload.Token)
	login := serve(loginRequest)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login for %q = %d, body %q", account.Handle, login.Code, login.Body.String())
	}
	return dataMaidSession{cookie: joinCookies(login.Header().Values("Set-Cookie")), token: payload.Token}
}

func seedDataMaidTree(t *testing.T, userRoot string, fixture dataMaidFixture) {
	t.Helper()
	fixed := time.Unix(fixture.Inputs.FixedMtimeSeconds, 0)
	for _, file := range fixture.Inputs.SeedFiles {
		content, err := base64.StdEncoding.DecodeString(file.BytesBase64)
		if err != nil {
			t.Fatalf("seed file %q: %v", file.Path, err)
		}
		target := filepath.Join(userRoot, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, content, 0o666); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(target, fixed, fixed); err != nil {
			t.Fatal(err)
		}
	}
}

// snapshotDataMaidTree walks the whole user root, skipping the recorded volatile files (pinned
// startup writes the boot wall-clock timestamp into stats.json), and returns it sorted by path.
func snapshotDataMaidTree(t *testing.T, root string, volatile []string) []userDataEntry {
	t.Helper()
	excluded := make(map[string]bool, len(volatile))
	for _, relative := range volatile {
		excluded[relative] = true
	}
	entries := make([]userDataEntry, 0)
	var walk func(directory, relative string)
	walk = func(directory, relative string) {
		directoryEntries, err := os.ReadDir(directory)
		if err != nil {
			return
		}
		for _, entry := range directoryEntries {
			child := entry.Name()
			if relative != "" {
				child = relative + "/" + entry.Name()
			}
			if excluded[child] {
				continue
			}
			if entry.IsDir() {
				entries = append(entries, userDataEntry{Path: child, Kind: "directory", Size: 0})
				walk(filepath.Join(directory, entry.Name()), child)
				continue
			}
			content, err := os.ReadFile(filepath.Join(directory, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			digest := userDataSHA256(content)
			entries = append(entries, userDataEntry{Path: child, Kind: "file", Size: int64(len(content)), Sha256: &digest})
		}
	}
	walk(root, "")
	sort.Slice(entries, func(left, right int) bool { return entries[left].Path < entries[right].Path })
	return entries
}

type dataMaidReplayState struct {
	tokens  map[string]string
	reports map[string]map[string][]map[string]any
}

var (
	dataMaidTokenReferencePattern   = regexp.MustCompile(`^<token:(.+?)>$`)
	dataMaidHashReferencePattern    = regexp.MustCompile(`^<hash:([^:]+):([a-z]+):(.*)>$`)
	dataMaidLiteralReferencePattern = regexp.MustCompile(`^<literal:(.*)>$`)
)

func buildDataMaidRequest(t *testing.T, step dataMaidFixtureStep, session dataMaidSession, state *dataMaidReplayState) *http.Request {
	t.Helper()
	values := url.Values{}
	for name, reference := range step.Request.Query {
		values.Set(name, resolveDataMaidReference(t, step.Name, reference, state))
	}
	for name, reference := range step.Request.DuplicateQuery {
		resolved := resolveDataMaidReference(t, step.Name, reference, state)
		values.Add(name, resolved)
		values.Add(name, resolved)
	}
	target := step.Request.Route
	if len(values) > 0 {
		target += "?" + values.Encode()
	}
	var body *bytes.Reader
	if len(step.Request.Body) > 0 && string(step.Request.Body) != "null" {
		resolved := resolveDataMaidBody(t, step.Name, step.Request.Body, state)
		body = bytes.NewReader(resolved)
	} else {
		body = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(step.Request.Method, target, body)
	request.Header.Set("Cookie", session.cookie)
	if step.Request.Method != http.MethodGet {
		request.Header.Set("X-CSRF-Token", session.token)
	}
	if len(step.Request.Body) > 0 && string(step.Request.Body) != "null" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func resolveDataMaidReference(t *testing.T, stepName, reference string, state *dataMaidReplayState) string {
	t.Helper()
	if match := dataMaidTokenReferencePattern.FindStringSubmatch(reference); match != nil {
		token, known := state.tokens[match[1]]
		if !known {
			t.Fatalf("%s: fixture references the token of step %q, which minted none", stepName, match[1])
		}
		return token
	}
	if match := dataMaidHashReferencePattern.FindStringSubmatch(reference); match != nil {
		report, known := state.reports[match[1]]
		if !known {
			t.Fatalf("%s: fixture references a hash from step %q, which returned no report", stepName, match[1])
		}
		for _, record := range report[match[2]] {
			if dataMaidRecordIdentity(match[2], record) == match[3] {
				hash, ok := record["hash"].(string)
				if !ok {
					t.Fatalf("%s: report record %s/%s has no hash", stepName, match[2], match[3])
				}
				return hash
			}
		}
		t.Fatalf("%s: report of step %q has no %s record %q", stepName, match[1], match[2], match[3])
	}
	if match := dataMaidLiteralReferencePattern.FindStringSubmatch(reference); match != nil {
		return match[1]
	}
	return reference
}

func resolveDataMaidBody(t *testing.T, stepName string, raw json.RawMessage, state *dataMaidReplayState) []byte {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("%s: recorded body is not JSON: %v", stepName, err)
	}
	encoded, err := marshalNodeJSON(resolveDataMaidValue(t, stepName, value, state))
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func resolveDataMaidValue(t *testing.T, stepName string, value any, state *dataMaidReplayState) any {
	t.Helper()
	switch typed := value.(type) {
	case string:
		return resolveDataMaidReference(t, stepName, typed, state)
	case []any:
		resolved := make([]any, len(typed))
		for index, item := range typed {
			resolved[index] = resolveDataMaidValue(t, stepName, item, state)
		}
		return resolved
	case map[string]any:
		resolved := make(map[string]any, len(typed))
		for key, item := range typed {
			resolved[key] = resolveDataMaidValue(t, stepName, item, state)
		}
		return resolved
	default:
		return value
	}
}

// dataMaidRecordIdentity is the fixture's marker key: `parent/name` for the two collectors that
// pass a parent, the bare name for the rest.
func dataMaidRecordIdentity(category string, record map[string]any) string {
	name, _ := record["name"].(string)
	parent, hasParent := record["parent"].(string)
	if !hasParent {
		return name
	}
	return parent + "/" + name
}

func compareDataMaidResponse(t *testing.T, step dataMaidFixtureStep, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Code != step.Response.Status {
		t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", step.Name, recorder.Code, step.Response.Status, recorder.Body.String())
	}
	// A report's content-length and ETag are digests of a body whose array order is the
	// filesystem's enumeration order, so the fixture records them as null and names the reason in
	// comparison.shapeReason. Everything else is compared, including headers the response must not
	// send.
	shapeHeaders := make(map[string]bool)
	for _, key := range step.Comparison.Shape {
		if name, found := strings.CutPrefix(key, "headers."); found {
			shapeHeaders[name] = true
		}
	}
	gotHeaders := make(map[string]string)
	for name, values := range recorder.Header() {
		lowered := strings.ToLower(name)
		if pinnedHeaderIsUnpinnable(lowered) || shapeHeaders[lowered] {
			continue
		}
		gotHeaders[lowered] = strings.Join(values, ", ")
	}
	wantHeaders := make(map[string]string, len(step.Response.Headers))
	for name, value := range step.Response.Headers {
		if value == nil || pinnedHeaderIsUnpinnable(name) {
			continue
		}
		wantHeaders[name] = *value
	}
	if !reflect.DeepEqual(gotHeaders, wantHeaders) {
		t.Fatalf("%s: headers = %#v, pinned Node has %#v", step.Name, gotHeaders, wantHeaders)
	}

	switch step.Response.BodyKind {
	case "json":
		var want any
		if err := json.Unmarshal(step.Response.Body, &want); err != nil {
			t.Fatalf("%s: recorded body is not JSON: %v", step.Name, err)
		}
		var actual any
		if err := json.Unmarshal(recorder.Body.Bytes(), &actual); err != nil {
			t.Fatalf("%s: response body is not JSON: %v (%q)", step.Name, err, recorder.Body.String())
		}
		if !reflect.DeepEqual(normalizeDataMaidReportBody(t, actual), want) {
			t.Fatalf("%s: report structure differs from pinned Node:\n got: %s\nwant: %s",
				step.Name, mustMarshalDataMaidJSON(t, normalizeDataMaidReportBody(t, actual)), mustMarshalDataMaidJSON(t, want))
		}
	case "bytes":
		body := recorder.Body.Bytes()
		if step.Response.BodyLength == nil || len(body) != *step.Response.BodyLength {
			t.Fatalf("%s: body length = %d, pinned Node has %v", step.Name, len(body), step.Response.BodyLength)
		}
		if step.Response.BodyBase64 == nil || base64.StdEncoding.EncodeToString(body) != *step.Response.BodyBase64 {
			t.Fatalf("%s: body bytes differ from pinned Node (%q)", step.Name, recorder.Body.String())
		}
		if step.Response.BodySha256 == nil || sha256ForTest(body) != *step.Response.BodySha256 {
			t.Fatalf("%s: body SHA-256 differs from pinned Node", step.Name)
		}
	default:
		t.Fatalf("%s: fixture body kind %q is unknown", step.Name, step.Response.BodyKind)
	}
}

// normalizeDataMaidReportBody reproduces the probe's recording normalization: the token becomes
// `<token>`, each record hash becomes its identity marker, and each array is sorted by
// (parent, name) because pinned emits directory enumeration order.
func normalizeDataMaidReportBody(t *testing.T, body any) any {
	t.Helper()
	object, ok := body.(map[string]any)
	if !ok {
		t.Fatalf("report body is not an object: %T", body)
	}
	report, ok := object["report"].(map[string]any)
	if !ok {
		t.Fatalf("report body has no report object")
	}
	// The token must be a real 32-byte token before it is replaced by the marker: substituting the
	// marker unconditionally would make the marker true even for a response that carried no token.
	token, ok := object["token"].(string)
	if !ok || len(token) != 64 || !dataMaidHexRunPattern.MatchString(token) {
		t.Fatalf("report body's token is not a 64-character hex string: %#v", object["token"])
	}
	normalized := make(map[string]any, len(report))
	for category, value := range report {
		records, ok := value.([]any)
		if !ok {
			t.Fatalf("report category %q is not an array", category)
		}
		normalizedRecords := make([]any, 0, len(records))
		for _, item := range records {
			record, ok := item.(map[string]any)
			if !ok {
				t.Fatalf("report category %q holds a non-object record", category)
			}
			ordered := make(map[string]any, 5)
			ordered["name"] = record["name"]
			ordered["hash"] = "<hash:" + category + ":" + dataMaidRecordIdentity(category, record) + ">"
			for _, member := range []string{"parent", "size", "mtime"} {
				if value, exists := record[member]; exists {
					ordered[member] = value
				}
			}
			normalizedRecords = append(normalizedRecords, ordered)
		}
		sort.SliceStable(normalizedRecords, func(left, right int) bool {
			leftRecord := normalizedRecords[left].(map[string]any)
			rightRecord := normalizedRecords[right].(map[string]any)
			return dataMaidSortKey(leftRecord) < dataMaidSortKey(rightRecord)
		})
		normalized[category] = normalizedRecords
	}
	return map[string]any{"report": normalized, "token": "<token>"}
}

func dataMaidSortKey(record map[string]any) string {
	parent, _ := record["parent"].(string)
	name, _ := record["name"].(string)
	return parent + "\x00" + name
}

func mustMarshalDataMaidJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// assertDataMaidTokenPaths is SOURCE-DERIVED, not an oracle: the token's path list is
// `{path, sha256(path)}` per category, and no recorded value can carry it. It is asserted here
// against the live store, using the token the response handed out, so a token that stopped
// storing absolute paths, or stored a hash of something else, fails.
func assertDataMaidTokenPaths(t *testing.T, stepName, token, userRoot string) {
	t.Helper()
	entry, found := lookupDataMaidToken(token)
	if !found {
		t.Fatalf("%s: the token in the response is not in the token store", stepName)
	}
	if entry.handle != "default-user" && entry.handle != "guest-user" {
		t.Fatalf("%s: token belongs to handle %q", stepName, entry.handle)
	}
	if len(entry.paths) == 0 && stepName != "report.guest" {
		t.Fatalf("%s: token stores no paths", stepName)
	}
	for _, stored := range entry.paths {
		if !filepath.IsAbs(stored.path) {
			t.Fatalf("%s: token path %q is not absolute", stepName, stored.path)
		}
		if !nodePathIsUnderParent(filepath.Join(filepath.Dir(userRoot), entry.handle), stored.path) {
			t.Fatalf("%s: token path %q is outside the user root", stepName, stored.path)
		}
		digest := sha256.Sum256([]byte(stored.path))
		if hex.EncodeToString(digest[:]) != stored.hash {
			t.Fatalf("%s: token hash for %q is not sha256 of the absolute path", stepName, stored.path)
		}
	}
}

// TestDataMaidUnreachableRefusalsAreSourceDerived covers the two `isPathUnderParent` refusals.
// They are SOURCE-DERIVED rather than oracle-backed: every path a token stores comes from a
// directory listing under the user root, so no reachable report can put a path outside it, and a
// recorded status for this branch would be evidence for behaviour that never ran. The test seeds
// the store the way only the code can and asserts the refusal consequence: 403 and the file
// still exists.
func TestDataMaidUnreachableRefusalsAreSourceDerived(t *testing.T) {
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	cookieSecret := "gotavern-data-maid-source-derived-cookie"
	account := dataMaidFixtureAccount{Handle: "default-user", Name: "Data Maid Probe", Admin: true}
	writeDataMaidAccount(t, dataRoot, account, "")
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{account.Handle}); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
	})
	session := dataMaidLogin(t, handler, account)

	outsideDirectory := t.TempDir()
	outsidePath := filepath.Join(outsideDirectory, "outside.txt")
	if err := os.WriteFile(outsidePath, []byte("must survive"), 0o600); err != nil {
		t.Fatal(err)
	}
	token := "00000000000000000000000000000000000000000000000000000000000000aa"
	digest := sha256.Sum256([]byte(outsidePath))
	outsideHash := hex.EncodeToString(digest[:])
	dataMaidTokens.Lock()
	dataMaidTokens.entries[token] = dataMaidTokenEntry{
		handle: account.Handle,
		paths:  []dataMaidStoredPath{{path: outsidePath, hash: outsideHash}},
	}
	dataMaidTokens.Unlock()
	defer forgetDataMaidToken(token)

	serve := func(request *http.Request) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	view := serve(dataMaidRequestWithSession(t, http.MethodGet, "/api/data-maid/view?token="+token+"&hash="+outsideHash, nil, session, false))
	if view.Code != http.StatusForbidden {
		t.Fatalf("view of a path outside the user root = %d, source says 403 (body %q)", view.Code, view.Body.String())
	}
	deleteBody, err := marshalNodeJSON(map[string]any{"token": token, "hashes": []string{outsideHash}})
	if err != nil {
		t.Fatal(err)
	}
	deleted := serve(dataMaidRequestWithSession(t, http.MethodPost, "/api/data-maid/delete", deleteBody, session, true))
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete of a path outside the user root = %d, source says 204 (body %q)", deleted.Code, deleted.Body.String())
	}
	if _, err := os.Stat(outsidePath); err != nil {
		t.Fatalf("delete removed a path outside the user root: %v", err)
	}
}

func dataMaidRequestWithSession(t *testing.T, method, target string, body []byte, session dataMaidSession, withBody bool) *http.Request {
	t.Helper()
	var reader *bytes.Reader
	if withBody {
		reader = bytes.NewReader(body)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(method, target, reader)
	request.Header.Set("Cookie", session.cookie)
	if method != http.MethodGet {
		request.Header.Set("X-CSRF-Token", session.token)
	}
	if withBody {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}
