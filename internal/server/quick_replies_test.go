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

type quickRepliesFixture struct {
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
		DeleteMainBody        string `json:"deleteMainBody"`
		DeleteMissingBody     string `json:"deleteMissingBody"`
		DeleteSanitizedBody   string `json:"deleteSanitizedBody"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		AfterMain        []quickReplyFileState `json:"afterMain"`
		AfterOverwrite   []quickReplyFileState `json:"afterOverwrite"`
		AfterSaves       []quickReplyFileState `json:"afterSaves"`
		AfterDeletes     []quickReplyFileState `json:"afterDeletes"`
		AccountUnchanged bool                  `json:"accountRecordUnchanged"`
		RoundTrip        struct {
			Verified bool `json:"verified"`
			Preset   struct {
				Name      string `json:"name"`
				RoundTrip string `json:"roundtrip"`
			} `json:"preset"`
		} `json:"roundTrip"`
	} `json:"state"`
}

type quickReplyFileState struct {
	Name    string  `json:"name"`
	Kind    string  `json:"kind"`
	Content *string `json:"content"`
}

func TestPinnedNodeQuickReplySaveAndDelete(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-quick-replies.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture quickRepliesFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("Quick Replies oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || fixture.Inputs.MainBody == "" {
		t.Fatal("Quick Replies oracle is missing required inputs")
	}
	if !fixture.State.RoundTrip.Verified || fixture.State.RoundTrip.Preset.Name != "Go-written" ||
		fixture.State.RoundTrip.Preset.RoundTrip != "visible to pinned Node" {
		t.Fatalf("Quick Replies oracle Node-to-Go-to-Node round trip = %+v", fixture.State.RoundTrip)
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
	}{"default-user", "Quick Reply Writer", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	if err := os.RemoveAll(directories["quickreplies"]); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(directories["quickreplies"], 0o755); err != nil {
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
		return serve(http.MethodPost, "/api/quick-replies/"+route, cookie, csrf.Token, []byte(body))
	}
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorizedSave":     post("save", fixture.Inputs.MainBody, csrfCookie),
		"legacySaveRedirect":   serve(http.MethodPost, "/savequickreply", sessionCookie, csrf.Token, []byte(fixture.Inputs.MainBody)),
		"legacyDeleteRedirect": serve(http.MethodPost, "/deletequickreply", sessionCookie, csrf.Token, []byte(fixture.Inputs.DeleteMainBody)),
		"saveMain":             post("save", fixture.Inputs.MainBody, sessionCookie),
	}
	afterMain := snapshotQuickReplyFiles(t, directories["quickreplies"])
	responses["overwriteMain"] = post("save", fixture.Inputs.OverwriteBody, sessionCookie)
	afterOverwrite := snapshotQuickReplyFiles(t, directories["quickreplies"])
	responses["saveSanitized"] = post("save", fixture.Inputs.SanitizedBody, sessionCookie)
	responses["saveLong"] = post("save", fixture.Inputs.LongBody, sessionCookie)
	responses["saveArrayName"] = post("save", fixture.Inputs.ArrayNameBody, sessionCookie)
	responses["saveObjectName"] = post("save", fixture.Inputs.ObjectNameBody, sessionCookie)
	responses["saveInvalidCharacters"] = post("save", fixture.Inputs.InvalidCharactersBody, sessionCookie)
	responses["saveControlCharacters"] = post("save", fixture.Inputs.ControlCharactersBody, sessionCookie)
	responses["saveMissingName"] = post("save", fixture.Inputs.MissingNameBody, sessionCookie)
	responses["saveFalsyName"] = post("save", fixture.Inputs.FalsyNameBody, sessionCookie)
	afterSaves := snapshotQuickReplyFiles(t, directories["quickreplies"])
	responses["deleteMain"] = post("delete", fixture.Inputs.DeleteMainBody, sessionCookie)
	responses["deleteMissing"] = post("delete", fixture.Inputs.DeleteMissingBody, sessionCookie)
	responses["deleteSanitized"] = post("delete", fixture.Inputs.DeleteSanitizedBody, sessionCookie)
	afterDeletes := snapshotQuickReplyFiles(t, directories["quickreplies"])
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountUnchanged {
		t.Fatal("Quick Replies mutations changed the account storage record")
	}
	for label, got := range map[string][]quickReplyFileState{
		"afterMain": afterMain, "afterOverwrite": afterOverwrite,
		"afterSaves": afterSaves, "afterDeletes": afterDeletes,
	} {
		var want []quickReplyFileState
		switch label {
		case "afterMain":
			want = fixture.State.AfterMain
		case "afterOverwrite":
			want = fixture.State.AfterOverwrite
		case "afterSaves":
			want = fixture.State.AfterSaves
		case "afterDeletes":
			want = fixture.State.AfterDeletes
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Quick Replies state %s = %+v; pinned Node has %+v", label, got, want)
		}
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("Quick Replies fixture has no response %q", label)
		}
		assertQuickRepliesResponse(t, label, got, want)
	}
}

func snapshotQuickReplyFiles(t *testing.T, directory string) []quickReplyFileState {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	files := make([]quickReplyFileState, 0, len(entries))
	for _, entry := range entries {
		state := quickReplyFileState{Name: entry.Name(), Kind: "other"}
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

func assertQuickRepliesResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	gotBody := any(nil)
	if got.Body.Len() > 0 {
		if json.Unmarshal(got.Body.Bytes(), &gotBody) != nil {
			gotBody = got.Body.String()
		}
	}
	gotHeaders := stableAccountBackupHeaders(got.Header())
	if got.Code != want.Status || !reflect.DeepEqual(gotHeaders, want.Headers) || !reflect.DeepEqual(gotBody, want.Body) {
		t.Fatalf("Quick Replies response %s differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", label, got.Code, want.Status, gotHeaders, want.Headers, gotBody, want.Body)
	}
}
