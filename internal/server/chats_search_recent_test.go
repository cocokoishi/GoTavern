package server

// Oracle test for the pinned /api/chats/search and /api/chats/recent routes.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type chatsSearchRecentScenarioFixture struct {
	Route    string                   `json:"route"`
	Request  string                   `json:"request"`
	Response characterResponseFixture `json:"response"`
}

type chatsSearchRecentFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret   string                              `json:"cookieSecret"`
		NewestMtimeMs  float64                             `json:"newestMtimeMs"`
		ChatFiles      map[string]chatsMutationFileFixture `json:"chatFiles"`
		GroupChatFiles map[string]chatsMutationFileFixture `json:"groupChatFiles"`
		GroupFiles     map[string]string                   `json:"groupFiles"`
		CardFiles      map[string]string                   `json:"cardFiles"`
	} `json:"inputs"`
	ScenarioOrder []string                                    `json:"scenarioOrder"`
	Scenarios     map[string]chatsSearchRecentScenarioFixture `json:"scenarios"`
}

func TestPinnedNodeChatsSearchRecent(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-chats-search-recent.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture chatsSearchRecentFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("chats search/recent oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.ChatFiles) == 0 {
		t.Fatal("chats search/recent oracle is missing inputs")
	}
	// The /recent ordering assertion is only discriminating when the seeded
	// mtimes are distinct: with ties the order would fall back to the concurrent
	// collectors' insertion order, which is not reproducible.
	seen := make(map[float64]string)
	for relative, seed := range fixture.Inputs.ChatFiles {
		if previous, exists := seen[seed.Mtime]; exists {
			t.Fatalf("%s and %s share the mtime %v, so the /recent ordering cannot be asserted", previous, relative, seed.Mtime)
		}
		seen[seed.Mtime] = relative
	}
	for relative, seed := range fixture.Inputs.GroupChatFiles {
		if previous, exists := seen[seed.Mtime]; exists {
			t.Fatalf("%s and %s share the mtime %v, so the /recent ordering cannot be asserted", previous, relative, seed.Mtime)
		}
		seen[seed.Mtime] = relative
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
	}{"default-user", "Chats Search Recent Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	for name, body := range fixture.Inputs.GroupFiles {
		if err := os.WriteFile(filepath.Join(directories["groups"], name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range fixture.Inputs.CardFiles {
		if err := os.WriteFile(filepath.Join(directories["characters"], name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
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

	for _, name := range fixture.ScenarioOrder {
		scenario, exists := fixture.Scenarios[name]
		if !exists {
			t.Fatalf("chats search/recent oracle has no %q scenario", name)
		}
		t.Run(name, func(t *testing.T) {
			response := serve(http.MethodPost, scenario.Route, sessionCookie, csrf.Token, "application/json", scenario.Request)
			assertCharacterResponse(t, name, response, scenario.Response)
		})
	}
}
