package server

// Oracle test for the pinned /api/groups routes.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

var generatedIDPattern = regexp.MustCompile(`\d{13}`)

type groupsScenarioFixture struct {
	Route    string                   `json:"route"`
	Request  string                   `json:"request"`
	Response characterResponseFixture `json:"response"`
	Groups   []chatsTreeEntry         `json:"groups"`
}

type groupsFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret     string                              `json:"cookieSecret"`
		NewestMtimeMs    float64                             `json:"newestMtimeMs"`
		GroupFileMtimeMs float64                             `json:"groupFileMtimeMs"`
		GroupFiles       map[string]chatsMutationFileFixture `json:"groupFiles"`
		GroupChatFiles   map[string]chatsMutationFileFixture `json:"groupChatFiles"`
	} `json:"inputs"`
	ScenarioOrder []string                         `json:"scenarioOrder"`
	Scenarios     map[string]groupsScenarioFixture `json:"scenarios"`
}

func TestPinnedNodeGroups(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-groups.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture groupsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("groups oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.GroupFiles) == 0 {
		t.Fatal("groups oracle is missing inputs")
	}

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	accountJSON, err := marshalNodeJSON(struct {
		Handle   string         `json:"handle"`
		Name     string         `json:"name"`
		Created  int64          `json:"created"`
		Password string         `json:"password"`
		Admin    bool           `json:"admin"`
		Enabled  bool           `json:"enabled"`
		Salt     string         `json:"salt"`
		Unknown  map[string]any `json:"probeUnknownField"`
	}{"default-user", "Groups Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	groupMtime := time.UnixMilli(int64(fixture.Inputs.GroupFileMtimeMs))
	for name, seed := range fixture.Inputs.GroupFiles {
		target := filepath.Join(directories["groups"], name)
		if err := os.WriteFile(target, []byte(seed.Body), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(target, groupMtime, groupMtime); err != nil {
			t.Fatal(err)
		}
	}
	for name, seed := range fixture.Inputs.GroupChatFiles {
		writeSeededChatFile(t, filepath.Join(directories["groupChats"], name), seed)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token, contentType, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, route, strings.NewReader(body))
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token != "" {
			request.Header.Set("X-CSRF-Token", token)
		}
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", "", "")
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatal(err)
	}
	cookiesFrom := func(response *httptest.ResponseRecorder) string {
		parts := make([]string, 0, 2)
		for _, cookie := range response.Header().Values("Set-Cookie") {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	login := serve(http.MethodPost, "/api/users/login", cookiesFrom(csrfResponse), csrf.Token, "application/json", `{"handle":"default-user","password":""}`)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookiesFrom(login)

	// /api/groups/create derives the id and file name from Date.now(), so two
	// creates inside one millisecond collide on a single file name. Wait for the
	// clock to pass the previous generated id before each create so the test
	// produces the same number of files as the oracle on any host. This is a
	// timing dependence: without it the tree depends on how fast the requests
	// happened to run.
	lastGeneratedID := int64(0)
	for _, name := range fixture.ScenarioOrder {
		scenario, exists := fixture.Scenarios[name]
		if !exists {
			t.Fatalf("groups oracle has no %q scenario", name)
		}
		t.Run(name, func(t *testing.T) {
			if scenario.Route == "/api/groups/create" {
				for time.Now().UnixMilli() <= lastGeneratedID {
					time.Sleep(time.Millisecond)
				}
			}
			response := serve(http.MethodPost, scenario.Route, sessionCookie, csrf.Token, "application/json", scenario.Request)
			if generated := generatedGroupID(response.Body.Bytes()); generated > lastGeneratedID {
				lastGeneratedID = generated
			}
			if strings.Contains(scenario.Response.BodyText, "<birthtimeMs>") {
				assertGroupsBirthtimeDerivation(t, name, response, fixture.Inputs.GroupFileMtimeMs)
			}
			copy := *response
			copy.Body = bytes.NewBuffer(normalizeGroupsJSON(response.Body.Bytes()))
			assertCharacterResponse(t, name, &copy, scenario.Response)
			assertGroupsTree(t, name+" groups", snapshotChatsTree(t, directories["groups"]), scenario.Groups)
		})
	}
}

// generatedGroupID returns the 13-digit id a /api/groups/create response
// carries, or 0 when the body has none.
func generatedGroupID(body []byte) int64 {
	parsed, err := decodeOrderedNodeJSON(body)
	if err != nil {
		return 0
	}
	id, ok := nodeGet(parsed, "id").stringValue()
	if !ok || !generatedIDPattern.MatchString(id) {
		return 0
	}
	value, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return 0
	}
	return value
}

// assertGroupsBirthtimeDerivation checks the pinned derivation between the two
// birthtime-derived members, and that neither is the seeded modification time.
//
// The birthtime value itself depends on the filesystem and cannot be seeded, so
// the fixture records it as a marker. Two properties are still discriminating:
// create_date must be exactly new Date(date_added).toISOString(), and
// date_added must not be the file's modification time, which the oracle seeds
// far away from the creation time. An implementation that reported mtime, or
// that derived the two members from different sources, fails here.
func assertGroupsBirthtimeDerivation(t *testing.T, label string, response *httptest.ResponseRecorder, seededMtime float64) {
	t.Helper()
	parsed, err := decodeOrderedNodeJSON(response.Body.Bytes())
	if err != nil || parsed.kind != 'a' {
		t.Fatalf("%s did not return an array: %s", label, response.Body.String())
	}
	if len(parsed.array) == 0 {
		t.Fatalf("%s returned no groups to check", label)
	}
	for index, group := range parsed.array {
		dateAdded, ok := jsNumber(nodeGet(group, "date_added"))
		if !ok {
			t.Fatalf("%s group %d has no numeric date_added", label, index)
		}
		if dateAdded == seededMtime {
			t.Fatalf("%s group %d date_added = %v, which is the seeded modification time; the pinned value is the file birthtime",
				label, index, dateAdded)
		}
		createDate, _ := nodeGet(group, "create_date").stringValue()
		if createDate != isoStringFromMilliseconds(dateAdded) {
			t.Fatalf("%s group %d create_date = %q; the pinned value is new Date(date_added).toISOString() = %q",
				label, index, createDate, isoStringFromMilliseconds(dateAdded))
		}
	}
}

// normalizeGroupsJSON rewrites generated ids and birthtime-derived members to
// the markers the oracle records, mirroring the probe.
func normalizeGroupsJSON(body []byte) []byte {
	parsed, err := decodeOrderedNodeJSON(body)
	if err != nil {
		return body
	}
	normalizeGroupsValue(&parsed)
	encoded, err := marshalCharacterJSON(parsed)
	if err != nil {
		return body
	}
	return encoded
}

func normalizeGroupsValue(value *orderedNodeJSON) {
	switch value.kind {
	case 's':
		text, ok := value.scalar.(string)
		if !ok {
			return
		}
		value.scalar = generatedIDPattern.ReplaceAllString(text, "<nowMs>")
	case 'o':
		for index := range value.object {
			key := value.object[index].key
			switch key {
			case "date_added":
				value.object[index].value = nodeString("<birthtimeMs>")
				continue
			case "create_date":
				value.object[index].value = nodeString("<birthtimeIso>")
				continue
			}
			normalizeGroupsValue(&value.object[index].value)
		}
	case 'a':
		for index := range value.array {
			normalizeGroupsValue(&value.array[index])
		}
	}
}

// assertGroupsTree compares a groups snapshot, normalizing generated file names
// and the digests of files whose content embeds the generated id.
func assertGroupsTree(t *testing.T, label string, got []chatsTreeEntry, want []chatsTreeEntry) {
	t.Helper()
	normalized := make([]chatsTreeEntry, len(got))
	for index, entry := range got {
		generated := generatedIDPattern.MatchString(entry.Path)
		entry.Path = generatedIDPattern.ReplaceAllString(entry.Path, "<nowMs>")
		if generated {
			entry.SHA256 = "<derived-from-generated-id>"
		}
		normalized[index] = entry
	}
	gotJSON, err := json.Marshal(normalized)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("%s tree differs from the pinned oracle:\n got: %s\nwant: %s", label, gotJSON, wantJSON)
	}
}
