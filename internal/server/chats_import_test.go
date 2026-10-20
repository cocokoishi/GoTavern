package server

// Oracle test for the pinned POST /api/chats/import.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

var (
	isoDatePattern     = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`)
	humanizedDateParts = regexp.MustCompile(`(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m(\d{2})s(\d{3})ms`)
)

type chatsImportScenarioFixture struct {
	Route     string  `json:"route"`
	JSON      *string `json:"json"`
	Multipart *struct {
		Fields   [][2]string `json:"fields"`
		Field    string      `json:"field"`
		Filename string      `json:"filename"`
		BytesHex string      `json:"bytesHex"`
	} `json:"multipart"`
	Response characterResponseFixture `json:"response"`
	Chats    []chatsTreeEntry         `json:"chats"`
}

type chatsImportFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string `json:"cookieSecret"`
	} `json:"inputs"`
	ScenarioOrder []string                              `json:"scenarioOrder"`
	Scenarios     map[string]chatsImportScenarioFixture `json:"scenarios"`
}

func TestPinnedNodeChatsImport(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-chats-import.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture chatsImportFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("chats import oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Scenarios) == 0 {
		t.Fatal("chats import oracle is missing inputs")
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
	}{"default-user", "Chats Import Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	if err := os.MkdirAll(filepath.Join(dataRoot, "_uploads"), 0o777); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	// The pinned route never creates the character chats directory and
	// write-file-atomic does not create parents, so seed the one character that
	// the happy-path scenarios import into.
	if err := os.MkdirAll(filepath.Join(directories["chats"], "Alice"), 0o777); err != nil {
		t.Fatal(err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token, contentType string, body []byte) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, route, bytes.NewReader(body))
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
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", "", nil)
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
	login := serve(http.MethodPost, "/api/users/login", cookiesFrom(csrfResponse), csrf.Token, "application/json", []byte(`{"handle":"default-user","password":""}`))
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookiesFrom(login)

	// The imported file name carries humanizedDateTime(), which has millisecond
	// resolution: two imports inside one millisecond would write the same file.
	// Wait for the clock to pass the previous import's name before the next one,
	// so the test produces the same number of files as the oracle on any host.
	lastImportMillis := int64(0)
	for _, name := range fixture.ScenarioOrder {
		scenario, exists := fixture.Scenarios[name]
		if !exists {
			t.Fatalf("chats import oracle has no %q scenario", name)
		}
		t.Run(name, func(t *testing.T) {
			if scenario.Multipart != nil {
				for time.Now().UnixMilli() <= lastImportMillis {
					time.Sleep(time.Millisecond)
				}
			}
			var response *httptest.ResponseRecorder
			if scenario.JSON != nil {
				response = serve(http.MethodPost, scenario.Route, sessionCookie, csrf.Token, "application/json", []byte(*scenario.JSON))
			} else {
				body, contentType := buildChatsImportMultipart(t, scenario)
				response = serve(http.MethodPost, scenario.Route, sessionCookie, csrf.Token, contentType, body)
			}
			if generated := lastImportNameMillis(response.Body.Bytes()); generated > lastImportMillis {
				lastImportMillis = generated
			}
			copy := *response
			copy.Body = bytes.NewBuffer(normalizeChatsImportJSON(response.Body.Bytes()))
			assertCharacterResponse(t, name, &copy, scenario.Response)
			assertChatsImportTree(t, name+" chats", snapshotChatsImportTree(t, directories["chats"]), scenario.Chats)
		})
	}
}

func buildChatsImportMultipart(t *testing.T, scenario chatsImportScenarioFixture) ([]byte, string) {
	t.Helper()
	body, err := hex.DecodeString(scenario.Multipart.BytesHex)
	if err != nil {
		t.Fatal(err)
	}
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for _, field := range scenario.Multipart.Fields {
		if err := writer.WriteField(field[0], field[1]); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile(scenario.Multipart.Field, scenario.Multipart.Filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes(), writer.FormDataContentType()
}

// normalizeChatsImportJSON rewrites the generated timestamps the oracle records
// as markers: the per-message ISO stamps and the humanizedDateTime() file name.
func normalizeChatsImportJSON(body []byte) []byte {
	parsed, err := decodeOrderedNodeJSON(body)
	if err != nil {
		return body
	}
	normalizeChatsImportValue(&parsed)
	encoded, err := marshalCharacterJSON(parsed)
	if err != nil {
		return body
	}
	return encoded
}

func normalizeChatsImportValue(value *orderedNodeJSON) {
	switch value.kind {
	case 's':
		text, ok := value.scalar.(string)
		if !ok {
			return
		}
		text = humanizedDateTimePattern.ReplaceAllString(text, "<humanizedDateTime>")
		value.scalar = isoDatePattern.ReplaceAllString(text, "<isoDate>")
	case 'o':
		for index := range value.object {
			normalizeChatsImportValue(&value.object[index].value)
		}
	case 'a':
		for index := range value.array {
			normalizeChatsImportValue(&value.array[index])
		}
	}
}

// lastImportNameMillis reads the humanizedDateTime() stamp out of the last
// generated file name, so the next import can be spaced past it.
func lastImportNameMillis(body []byte) int64 {
	parsed, err := decodeOrderedNodeJSON(body)
	if err != nil {
		return 0
	}
	names := nodeGet(parsed, "fileNames")
	if names.kind != 'a' || len(names.array) == 0 {
		return 0
	}
	name, ok := names.array[len(names.array)-1].stringValue()
	if !ok {
		return 0
	}
	return humanizedNameMillis(name)
}

func humanizedNameMillis(name string) int64 {
	match := humanizedDateParts.FindStringSubmatch(name)
	if match == nil {
		return 0
	}
	parts := make([]int, 0, 7)
	for _, field := range match[1:] {
		value, err := strconv.Atoi(field)
		if err != nil {
			return 0
		}
		parts = append(parts, value)
	}
	return time.Date(parts[0], time.Month(parts[1]), parts[2], parts[3], parts[4], parts[5], parts[6]*int(time.Millisecond), time.Local).UnixMilli()
}

// snapshotChatsImportTree mirrors the probe's walk with one difference: file
// digests are taken over the content with the generated timestamps normalized,
// because every imported message carries new Date().toISOString(). The digest
// therefore still asserts the imported text, message order and JSON shape.
func snapshotChatsImportTree(t *testing.T, root string) []chatsTreeEntry {
	t.Helper()
	entries := make([]chatsTreeEntry, 0, 8)
	var walk func(current, prefix string)
	walk = func(current, prefix string) {
		names, err := os.ReadDir(current)
		if err != nil {
			t.Fatal(err)
		}
		sort.Slice(names, func(left, right int) bool { return names[left].Name() < names[right].Name() })
		for _, name := range names {
			target := filepath.Join(current, name.Name())
			relative := name.Name()
			if prefix != "" {
				relative = prefix + "/" + name.Name()
			}
			info, err := os.Stat(target)
			if err != nil {
				t.Fatal(err)
			}
			if info.IsDir() {
				entries = append(entries, chatsTreeEntry{Path: relative, Kind: "directory"})
				walk(target, relative)
				continue
			}
			body, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			normalized := isoDatePattern.ReplaceAllString(humanizedDateTimePattern.ReplaceAllString(string(body), "<humanizedDateTime>"), "<isoDate>")
			digest := sha256.Sum256([]byte(normalized))
			entries = append(entries, chatsTreeEntry{
				Path: relative, Kind: "file", SHA256: hex.EncodeToString(digest[:]), Bytes: len(body),
			})
		}
	}
	if _, err := os.Stat(root); err == nil {
		walk(root, "")
	}
	return entries
}

func assertChatsImportTree(t *testing.T, label string, got []chatsTreeEntry, want []chatsTreeEntry) {
	t.Helper()
	normalized := make([]chatsTreeEntry, len(got))
	for index, entry := range got {
		entry.Path = humanizedDateTimePattern.ReplaceAllString(entry.Path, "<humanizedDateTime>")
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
