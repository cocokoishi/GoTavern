package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type movingUIFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret          string `json:"cookieSecret"`
		MainBody              string `json:"mainBody"`
		OverwriteBody         string `json:"overwriteBody"`
		SanitizedBody         string `json:"sanitizedBody"`
		LongBody              string `json:"longBody"`
		ArrayNameBody         string `json:"arrayNameBody"`
		ObjectNameBody        string `json:"objectNameBody"`
		InvalidCharactersBody string `json:"invalidCharactersBody"`
		ControlCharactersBody string `json:"controlCharactersBody"`
		MissingNameBody       string `json:"missingNameBody"`
		FalsyNameBody         string `json:"falsyNameBody"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		AfterMain        []movingUIFileState `json:"afterMain"`
		AfterOverwrite   []movingUIFileState `json:"afterOverwrite"`
		AfterSaves       []movingUIFileState `json:"afterSaves"`
		AccountUnchanged bool                `json:"accountRecordUnchanged"`
		RoundTrip        struct {
			Verified bool `json:"verified"`
			Preset   struct {
				Name          string          `json:"name"`
				RoundTrip     string          `json:"roundtrip"`
				MovingUIState json.RawMessage `json:"movingUIState"`
			} `json:"preset"`
		} `json:"roundTrip"`
	} `json:"state"`
}

type movingUIFileState struct {
	Name    string  `json:"name"`
	Kind    string  `json:"kind"`
	Content *string `json:"content"`
}

func TestPinnedNodeMovingUISave(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-moving-ui.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture movingUIFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("Moving UI presets oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || fixture.Inputs.MainBody == "" {
		t.Fatal("Moving UI presets oracle is missing required inputs")
	}
	var movingUIState struct {
		Chat struct {
			Left int
			Top  int
		}
	}
	if err := json.Unmarshal(fixture.State.RoundTrip.Preset.MovingUIState, &movingUIState); err != nil {
		t.Fatal(err)
	}
	if !fixture.State.RoundTrip.Verified || fixture.State.RoundTrip.Preset.Name != "Go-written" ||
		fixture.State.RoundTrip.Preset.RoundTrip != "visible to pinned Node" ||
		movingUIState.Chat.Left != 200 || movingUIState.Chat.Top != 300 {
		t.Fatalf("Moving UI presets oracle Node-to-Go-to-Node round trip = %+v", fixture.State.RoundTrip)
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
	}{"default-user", "Moving UI Writer", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	accountRecordPath := filepath.Join(dataRoot, userStorageFolder, nodeStoreFilename(userStoragePrefix+"default-user"))
	accountRecordBefore, err := os.ReadFile(accountRecordPath)
	if err != nil {
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
	if err := os.RemoveAll(directories["movingUI"]); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(directories["movingUI"], 0o755); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, route, bytes.NewReader(body))
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token != "" {
			request.Header.Set("X-CSRF-Token", token)
		}
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", nil)
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d, body %q", csrfResponse.Code, csrfResponse.Body.String())
	}
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatal(err)
	}
	cookieFrom := func(cookies []string) string {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, []byte(`{"handle":"default-user","password":""}`))
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))
	post := func(route, body string, cookie string) *httptest.ResponseRecorder {
		return serve(http.MethodPost, "/api/moving-ui/"+route, cookie, csrf.Token, []byte(body))
	}
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorizedSave":   post("save", fixture.Inputs.MainBody, csrfCookie),
		"legacySaveRedirect": serve(http.MethodPost, "/savemovingui", sessionCookie, csrf.Token, []byte(fixture.Inputs.MainBody)),
		"saveMain":           post("save", fixture.Inputs.MainBody, sessionCookie),
	}
	afterMain := snapshotMovingUIFiles(t, directories["movingUI"])
	responses["overwriteMain"] = post("save", fixture.Inputs.OverwriteBody, sessionCookie)
	afterOverwrite := snapshotMovingUIFiles(t, directories["movingUI"])
	responses["saveSanitized"] = post("save", fixture.Inputs.SanitizedBody, sessionCookie)
	responses["saveLong"] = post("save", fixture.Inputs.LongBody, sessionCookie)
	responses["saveArrayName"] = post("save", fixture.Inputs.ArrayNameBody, sessionCookie)
	responses["saveObjectName"] = post("save", fixture.Inputs.ObjectNameBody, sessionCookie)
	responses["saveInvalidCharacters"] = post("save", fixture.Inputs.InvalidCharactersBody, sessionCookie)
	responses["saveControlCharacters"] = post("save", fixture.Inputs.ControlCharactersBody, sessionCookie)
	responses["saveMissingName"] = post("save", fixture.Inputs.MissingNameBody, sessionCookie)
	responses["saveFalsyName"] = post("save", fixture.Inputs.FalsyNameBody, sessionCookie)
	afterSaves := snapshotMovingUIFiles(t, directories["movingUI"])
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountUnchanged {
		t.Fatal("Moving UI presets mutations changed the account storage record")
	}
	for label, got := range map[string][]movingUIFileState{
		"afterMain": afterMain, "afterOverwrite": afterOverwrite,
		"afterSaves": afterSaves,
	} {
		var want []movingUIFileState
		switch label {
		case "afterMain":
			want = fixture.State.AfterMain
		case "afterOverwrite":
			want = fixture.State.AfterOverwrite
		case "afterSaves":
			want = fixture.State.AfterSaves
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Moving UI presets state %s = %+v; pinned Node has %+v", label, got, want)
		}
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("Moving UI presets fixture has no response %q", label)
		}
		assertMovingUIResponse(t, label, got, want)
	}
}

func snapshotMovingUIFiles(t *testing.T, directory string) []movingUIFileState {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	files := make([]movingUIFileState, 0, len(entries))
	for _, entry := range entries {
		state := movingUIFileState{Name: entry.Name(), Kind: "other"}
		info, err := entry.Info()
		if err != nil {
			t.Fatal(err)
		}
		switch {
		case info.Mode().IsRegular():
			state.Kind = "file"
			body, err := os.ReadFile(filepath.Join(directory, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			content := string(body)
			state.Content = &content
		case info.IsDir():
			state.Kind = "directory"
		}
		files = append(files, state)
	}
	return files
}

func assertMovingUIResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	gotBody := any(nil)
	if got.Body.Len() > 0 {
		if json.Unmarshal(got.Body.Bytes(), &gotBody) != nil {
			gotBody = got.Body.String()
		}
	}
	gotHeaders := stableAccountBackupHeaders(got.Header())
	if got.Code != want.Status || !reflect.DeepEqual(gotHeaders, want.Headers) || !reflect.DeepEqual(gotBody, want.Body) {
		t.Fatalf("Moving UI presets response %s differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", label, got.Code, want.Status, gotHeaders, want.Headers, gotBody, want.Body)
	}
}
