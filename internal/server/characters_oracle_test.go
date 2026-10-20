package server

// Shared helpers for the pinned characters-domain oracle tests.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type characterResponseFixture struct {
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	Body       json.RawMessage   `json:"body"`
	BodyIsJSON bool              `json:"bodyIsJSON"`
}

// charactersFixture is the shared shape of every characters oracle fixture.
type charactersFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Probe      string   `json:"probe"`
	Normalizer []string `json:"normalization"`
	Inputs     struct {
		CookieSecret string  `json:"cookieSecret"`
		FixedMtimeMS float64 `json:"fixedMtimeMs"`
		Cards        []struct {
			File     string `json:"file"`
			BytesHex string `json:"bytesHex"`
		} `json:"cards"`
		ChatFiles     map[string]string `json:"chatFiles"`
		ChatCharacter string            `json:"chatCharacter"`
	} `json:"inputs"`
	Responses map[string]characterResponseFixture `json:"responses"`
}

func readCharactersFixture(t *testing.T, name string) charactersFixture {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", name))
	if err != nil {
		t.Fatal(err)
	}
	var fixture charactersFixture
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("%s baseline = %+v", name, fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Cards) == 0 {
		t.Fatalf("%s is missing inputs", name)
	}
	return fixture
}

type charactersOracleEnv struct {
	DataRoot    string
	InstallRoot string
	Directories map[string]string
	Handler     http.Handler
	Cookie      string
	Token       string
}

func newCharactersOracleEnv(t *testing.T, fixture charactersFixture) *charactersOracleEnv {
	t.Helper()
	return newCharactersOracleEnvWithConfig(t, fixture, "")
}

// newCharactersOracleEnvWithConfig builds the handler with an optional
// runtime config.yaml, which is how performance.lazyLoadCharacters reaches the
// pinned getConfigValue call.
func newCharactersOracleEnvWithConfig(t *testing.T, fixture charactersFixture, configYAML string) *charactersOracleEnv {
	t.Helper()
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	if configYAML != "" {
		if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), []byte(configYAML), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	accountJSON, err := marshalNodeJSON(struct {
		Handle   string         `json:"handle"`
		Name     string         `json:"name"`
		Created  int64          `json:"created"`
		Password string         `json:"password"`
		Admin    bool           `json:"admin"`
		Enabled  bool           `json:"enabled"`
		Salt     string         `json:"salt"`
		Unknown  map[string]any `json:"probeUnknownField"`
	}{"default-user", "Characters Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	env := &charactersOracleEnv{
		DataRoot: dataRoot, InstallRoot: installRoot, Directories: directories,
		Handler: NewHTTPHandlerWithOptions(HTTPHandlerOptions{
			InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
		}),
	}
	csrf := env.serve(t, http.MethodGet, "/csrf-token", "", "")
	if csrf.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrf.Code)
	}
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrf.Body.Bytes(), &token); err != nil {
		t.Fatal(err)
	}
	cookies := func(response *httptest.ResponseRecorder) string {
		parts := make([]string, 0, 2)
		for _, cookie := range response.Header().Values("Set-Cookie") {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfCookie := cookies(csrf)
	login := env.serveWithCookie(t, http.MethodPost, "/api/users/login", csrfCookie, token.Token, "application/json", `{"handle":"default-user","password":""}`)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d body %q", login.Code, login.Body.String())
	}
	env.Cookie = cookies(login)
	env.Token = token.Token
	return env
}

func (env *charactersOracleEnv) serve(t *testing.T, method, route, contentType, body string) *httptest.ResponseRecorder {
	t.Helper()
	return env.serveWithCookie(t, method, route, env.Cookie, env.Token, contentType, body)
}

func (env *charactersOracleEnv) serveWithCookie(t *testing.T, method, route, cookie, token, contentType, body string) *httptest.ResponseRecorder {
	t.Helper()
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
	env.Handler.ServeHTTP(response, request)
	return response
}

// writeFixtureCards materializes the pinned card PNG bytes into the characters
// directory with the fixture's fixed mtime.
func (env *charactersOracleEnv) writeFixtureCards(t *testing.T, fixture charactersFixture) {
	t.Helper()
	root := env.Directories["characters"]
	if err := os.MkdirAll(root, 0o777); err != nil {
		t.Fatal(err)
	}
	for _, card := range fixture.Inputs.Cards {
		body, err := hex.DecodeString(card.BytesHex)
		if err != nil {
			t.Fatal(err)
		}
		writeFixtureFile(t, filepath.Join(root, card.File), body, fixture.Inputs.FixedMtimeMS)
	}
}

// writeFixtureChats materializes the pinned chat files and the empty chat
// directory used by the /chats scenarios.
func (env *charactersOracleEnv) writeFixtureChats(t *testing.T, fixture charactersFixture) {
	t.Helper()
	chatsRoot := env.Directories["chats"]
	characterChats := filepath.Join(chatsRoot, fixture.Inputs.ChatCharacter)
	if err := os.MkdirAll(filepath.Join(characterChats, "nested"), 0o777); err != nil {
		t.Fatal(err)
	}
	for name, body := range fixture.Inputs.ChatFiles {
		writeFixtureFile(t, filepath.Join(characterChats, name), []byte(body), fixture.Inputs.FixedMtimeMS)
	}
	// calculateChatSize stats directories too, so the nested directory's mtime
	// participates in date_last_chat.
	fixed := time.UnixMilli(int64(fixture.Inputs.FixedMtimeMS))
	if err := os.Chtimes(filepath.Join(characterChats, "nested"), fixed, fixed); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(chatsRoot, "Backfill V2"), 0o777); err != nil {
		t.Fatal(err)
	}
}

func writeFixtureFile(t *testing.T, path string, body []byte, mtimeMilliseconds float64) {
	t.Helper()
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	fixed := time.UnixMilli(int64(mtimeMilliseconds))
	if err := os.Chtimes(path, fixed, fixed); err != nil {
		t.Fatal(err)
	}
}

// normalizeCharacterCtime replaces the ctime-derived date_added member with the
// fixture marker, matching the probe's documented normalization.
func normalizeCharacterCtime(value *orderedNodeJSON) {
	switch value.kind {
	case 'o':
		for index := range value.object {
			if value.object[index].key == "date_added" {
				value.object[index].value = nodeString("<ctimeMs>")
				continue
			}
			normalizeCharacterCtime(&value.object[index].value)
		}
	case 'a':
		for index := range value.array {
			normalizeCharacterCtime(&value.array[index])
		}
	}
}

func normalizeCharacterCtimeBody(body []byte) []byte {
	parsed, err := decodeOrderedNodeJSON(body)
	if err != nil {
		return body
	}
	normalizeCharacterCtime(&parsed)
	normalized, err := marshalCharacterJSON(parsed)
	if err != nil {
		return body
	}
	return normalized
}

// assertCharacterResponse compares one characters response against the pinned
// fixture.
//
// content-encoding/transfer-encoding are excluded because pinned Node gzips and
// chunk-encodes these JSON bodies while GoTavern does not yet reproduce the
// compression middleware. Headers recorded as "<derived-from-normalized-body>"
// are functions of the normalized ctime marker and are excluded for the same
// reason the marker is documented.
func assertCharacterResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want characterResponseFixture) {
	t.Helper()
	if got.Code != want.Status {
		t.Fatalf("%s status = %d; pinned Node has %d (body %q)", label, got.Code, want.Status, got.Body.String())
	}
	gotHeaders := got.Header().Clone()
	gotHeaders.Del("Content-Encoding")
	gotHeaders.Del("Transfer-Encoding")
	wantHeaders := make(map[string]string, len(want.Headers))
	for name, value := range want.Headers {
		switch {
		case name == "content-encoding" || name == "transfer-encoding":
			continue
		case value == "<derived-from-normalized-body>":
			gotHeaders.Del(name)
			continue
		}
		wantHeaders[name] = value
	}
	assertPinnedHeaders(t, gotHeaders, wantHeaders)

	wantBody := compactJSON(want.Body)
	gotBody := got.Body.Bytes()
	if !want.BodyIsJSON {
		// The probe records non-JSON bodies verbatim; an empty response body is
		// recorded as null.
		if len(wantBody) == 0 || bytes.Equal(wantBody, []byte("null")) {
			if len(gotBody) != 0 {
				t.Fatalf("%s body = %q; pinned Node returned an empty body", label, gotBody)
			}
			return
		}
		var text string
		if err := json.Unmarshal(want.Body, &text); err != nil {
			t.Fatalf("%s fixture body is not a JSON string: %s", label, want.Body)
		}
		if string(gotBody) != text {
			t.Fatalf("%s body = %q; pinned Node has %q", label, gotBody, text)
		}
		return
	}
	if bytes.Contains(wantBody, []byte("<ctimeMs>")) {
		gotBody = normalizeCharacterCtimeBody(gotBody)
	}
	if !bytes.Equal(gotBody, wantBody) {
		t.Fatalf("%s body differs from the pinned Node oracle:\n got: %s\nwant: %s", label, gotBody, wantBody)
	}
}
