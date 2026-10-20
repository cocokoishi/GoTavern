package server

// Oracle test for the pinned chat rename/delete/export and group-chat routes.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type chatsMutationFileFixture struct {
	Body  string  `json:"body"`
	Mtime float64 `json:"mtime"`
}

type chatsMutationScenarioFixture struct {
	Route     string  `json:"route"`
	Request   *string `json:"request"`
	Multipart *struct {
		Field    string `json:"field"`
		Filename string `json:"filename"`
		BytesHex string `json:"bytesHex"`
	} `json:"multipart"`
	Response   characterResponseFixture `json:"response"`
	Chats      []chatsTreeEntry         `json:"chats"`
	GroupChats []chatsTreeEntry         `json:"groupChats"`
}

type chatsMutationsFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret   string                              `json:"cookieSecret"`
		NewestMtimeMs  float64                             `json:"newestMtimeMs"`
		ChatFiles      map[string]chatsMutationFileFixture `json:"chatFiles"`
		GroupChatFiles map[string]chatsMutationFileFixture `json:"groupChatFiles"`
	} `json:"inputs"`
	ScenarioOrder []string                                `json:"scenarioOrder"`
	Scenarios     map[string]chatsMutationScenarioFixture `json:"scenarios"`
}

func TestPinnedNodeChatsMutations(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-chats-mutations.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture chatsMutationsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("chats mutations oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.ChatFiles) == 0 {
		t.Fatal("chats mutations oracle is missing inputs")
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
	}{"default-user", "Chats Mutations Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	for relative, seed := range fixture.Inputs.ChatFiles {
		target := filepath.Join(directories["chats"], filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			t.Fatal(err)
		}
		writeSeededChatFile(t, target, seed)
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
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrfResponse.Code)
	}
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
	csrfCookie := cookiesFrom(csrfResponse)
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, "application/json", `{"handle":"default-user","password":""}`)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookiesFrom(login)

	for _, name := range fixture.ScenarioOrder {
		scenario, exists := fixture.Scenarios[name]
		if !exists {
			t.Fatalf("chats mutations oracle has no %q scenario", name)
		}
		t.Run(name, func(t *testing.T) {
			var response *httptest.ResponseRecorder
			if scenario.Multipart != nil {
				body, contentType := buildChatsMultipart(t, scenario)
				request := httptest.NewRequest(http.MethodPost, scenario.Route, bytes.NewReader(body))
				request.Header.Set("Content-Type", contentType)
				request.Header.Set("Cookie", sessionCookie)
				request.Header.Set("X-CSRF-Token", csrf.Token)
				response = httptest.NewRecorder()
				handler.ServeHTTP(response, request)
			} else {
				request := ""
				if scenario.Request != nil {
					request = *scenario.Request
				}
				response = serve(http.MethodPost, scenario.Route, sessionCookie, csrf.Token, "application/json", request)
			}
			assertChatsMutationResponse(t, name, response, scenario.Response, dataRoot)
			assertChatsTreeEntries(t, name+" chats", snapshotChatsTree(t, directories["chats"]), scenario.Chats)
			assertChatsTreeEntries(t, name+" group chats", snapshotChatsTree(t, directories["groupChats"]), scenario.GroupChats)
		})
	}
}

func writeSeededChatFile(t *testing.T, target string, seed chatsMutationFileFixture) {
	t.Helper()
	if err := os.WriteFile(target, []byte(seed.Body), 0o600); err != nil {
		t.Fatal(err)
	}
	fixed := time.UnixMilli(int64(seed.Mtime))
	if err := os.Chtimes(target, fixed, fixed); err != nil {
		t.Fatal(err)
	}
}

func buildChatsMultipart(t *testing.T, scenario chatsMutationScenarioFixture) ([]byte, string) {
	t.Helper()
	body, err := hex.DecodeString(scenario.Multipart.BytesHex)
	if err != nil {
		t.Fatal(err)
	}
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
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

// assertChatsMutationResponse compares one recorded response.
//
// The pinned export 404 echoes an absolute server path, so a recorded string
// that embeds the runtime data root is rewritten to the probe's
// <runtimeRoot>/data marker with forward slashes. The rewrite is applied to the
// decoded JSON value, never to the raw text, so JSON escape sequences are
// untouched. That is the documented normalization in the fixture and in
// docs/compat-matrix.md; it is the only host-dependent value in this fixture.
func assertChatsMutationResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want characterResponseFixture, dataRoot string) {
	t.Helper()
	copy := *got
	copy.Body = bytes.NewBuffer(normalizeRuntimeRootJSON(got.Body.Bytes(), dataRoot))
	assertCharacterResponse(t, label, &copy, want)
}

func normalizeRuntimeRootJSON(body []byte, dataRoot string) []byte {
	parsed, err := decodeOrderedNodeJSON(body)
	if err != nil {
		return body
	}
	normalizeChatsResponseValue(&parsed, dataRoot)
	encoded, err := marshalCharacterJSON(parsed)
	if err != nil {
		return body
	}
	return encoded
}

// normalizeChatsResponseValue applies the two documented normalizations to a
// decoded response: humanizedDateTime() values and strings that embed the
// runtime data root. Both are applied to decoded string values, never to raw
// text, so JSON escape sequences stay intact.
func normalizeChatsResponseValue(value *orderedNodeJSON, dataRoot string) {
	switch value.kind {
	case 's':
		text, ok := value.scalar.(string)
		if !ok {
			return
		}
		text = humanizedDateTimePattern.ReplaceAllString(text, "<humanizedDateTime>")
		if strings.Contains(text, dataRoot) {
			text = strings.ReplaceAll(strings.ReplaceAll(text, dataRoot, "<runtimeRoot>/data"), "\\", "/")
		}
		value.scalar = text
	case 'o':
		for index := range value.object {
			normalizeChatsResponseValue(&value.object[index].value, dataRoot)
		}
	case 'a':
		for index := range value.array {
			normalizeChatsResponseValue(&value.array[index], dataRoot)
		}
	}
}

func assertChatsTreeEntries(t *testing.T, label string, got []chatsTreeEntry, want []chatsTreeEntry) {
	t.Helper()
	// /group/import names its file with humanizedDateTime(), which the oracle
	// records as a marker; apply the same normalization to the Go snapshot.
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
