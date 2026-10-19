package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type avatarsDeleteFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret     string                                `json:"cookieSecret"`
		Files            []avatarDeleteFileInput               `json:"files"`
		Requests         map[string]map[string]json.RawMessage `json:"requests"`
		GoRoundTripInput struct {
			Avatar           string `json:"avatar"`
			AvatarContent    string `json:"avatarContent"`
			ThumbnailContent string `json:"thumbnailContent"`
		} `json:"goRoundTripInput"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		FileStates             map[string]avatarDeleteState `json:"fileStates"`
		AccountRecordUnchanged bool                         `json:"accountRecordUnchanged"`
		GoRoundTrip            avatarDeleteRoundTrip        `json:"goRoundTrip"`
	} `json:"state"`
}

type avatarDeleteFileInput struct {
	Directory string `json:"directory"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Content   string `json:"content"`
}

type avatarDeleteFileState struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	SHA256 string `json:"sha256,omitempty"`
}

type avatarDeleteState struct {
	Avatars    []avatarDeleteFileState `json:"avatars"`
	Thumbnails []avatarDeleteFileState `json:"thumbnails"`
}

type avatarDeleteRoundTrip struct {
	GoResponse     accountMutationResponseFixture `json:"goResponse"`
	NodeAvatarList accountMutationResponseFixture `json:"nodeAvatarList"`
	FileState      avatarDeleteState              `json:"fileState"`
}

func TestPinnedNodePersonaAvatarDeletion(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-avatars-delete.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture avatarsDeleteFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("avatar-delete oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Files) == 0 || len(fixture.Inputs.Requests) == 0 {
		t.Fatal("avatar-delete oracle is missing required inputs")
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
	}{"default-user", "Avatar Deleter", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	for _, file := range fixture.Inputs.Files {
		var directory string
		switch file.Directory {
		case "avatars":
			directory = directories["avatars"]
		case "thumbnailsPersona":
			directory = directories["thumbnailsPersona"]
		default:
			t.Fatalf("unexpected avatar fixture directory %q", file.Directory)
		}
		target := filepath.Join(directory, file.Name)
		switch file.Kind {
		case "file":
			if err := os.WriteFile(target, []byte(file.Content), 0o600); err != nil {
				t.Fatal(err)
			}
		case "directory":
			if err := os.Mkdir(target, 0o755); err != nil {
				t.Fatal(err)
			}
		default:
			t.Fatalf("unexpected avatar fixture entry kind %q", file.Kind)
		}
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
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, []byte("{\"handle\":\"default-user\",\"password\":\"\"}"))
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))

	responses := make(map[string]*httptest.ResponseRecorder)
	fileStates := make(map[string]avatarDeleteState)
	fileStates["initial"] = snapshotAvatarDeleteState(t, directories["avatars"], directories["thumbnailsPersona"])
	actions := []struct {
		label       string
		requestName string
		route       string
		cookie      string
	}{
		{label: "unauthorized", requestName: "deleteAvatar", route: "/api/avatars/delete", cookie: csrfCookie},
		{label: "legacyRedirect", requestName: "deleteAvatar", route: "/deleteuseravatar"},
		{label: "deleteAvatar", requestName: "deleteAvatar", route: "/api/avatars/delete"},
		{label: "deleteAvatarAgain", requestName: "deleteAvatar", route: "/api/avatars/delete"},
		{label: "missingAvatar", requestName: "missingAvatar", route: "/api/avatars/delete"},
		{label: "invalidSeparator", requestName: "invalidSeparator", route: "/api/avatars/delete"},
		{label: "sanitizerMismatch", requestName: "sanitizerMismatch", route: "/api/avatars/delete"},
	}
	for _, action := range actions {
		body, exists := fixture.Inputs.Requests[action.requestName]
		if !exists {
			t.Fatalf("avatar-delete fixture has no request %q", action.requestName)
		}
		bodyBytes, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		cookie := action.cookie
		if cookie == "" {
			cookie = sessionCookie
		}
		responses[action.label] = serve(http.MethodPost, action.route, cookie, csrf.Token, bodyBytes)
		fileStates[action.label] = snapshotAvatarDeleteState(t, directories["avatars"], directories["thumbnailsPersona"])
	}
	goRoundTripInput := fixture.Inputs.GoRoundTripInput
	if goRoundTripInput.Avatar == "" || goRoundTripInput.AvatarContent == "" || goRoundTripInput.ThumbnailContent == "" {
		t.Fatal("avatar-delete oracle has no Go-to-Node round-trip input")
	}
	if err := os.WriteFile(filepath.Join(directories["avatars"], goRoundTripInput.Avatar), []byte(goRoundTripInput.AvatarContent), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directories["thumbnailsPersona"], goRoundTripInput.Avatar), []byte(goRoundTripInput.ThumbnailContent), 0o600); err != nil {
		t.Fatal(err)
	}
	roundTripBody, err := json.Marshal(map[string]string{"avatar": goRoundTripInput.Avatar})
	if err != nil {
		t.Fatal(err)
	}
	goRoundTripResponse := serve(http.MethodPost, "/api/avatars/delete", sessionCookie, csrf.Token, roundTripBody)
	assertAvatarResponse(t, "avatar Go-to-Node round-trip", goRoundTripResponse, fixture.State.GoRoundTrip.GoResponse)
	goRoundTripState := snapshotAvatarDeleteState(t, directories["avatars"], directories["thumbnailsPersona"])
	if !reflect.DeepEqual(goRoundTripState, fixture.State.GoRoundTrip.FileState) {
		t.Fatalf("Go-to-Node avatar-delete state = %+v; pinned Node has %+v", goRoundTripState, fixture.State.GoRoundTrip.FileState)
	}
	if fixture.State.GoRoundTrip.NodeAvatarList.Status != http.StatusOK || !reflect.DeepEqual(fixture.State.GoRoundTrip.NodeAvatarList.Body, []any{"other.png"}) {
		t.Fatalf("pinned Node avatar-list readback after Go deletion = %+v", fixture.State.GoRoundTrip.NodeAvatarList)
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("avatar deletion changed the account storage record")
	}
	if !reflect.DeepEqual(fileStates, fixture.State.FileStates) {
		t.Fatalf("avatar file states differ from pinned Node:\n got=%+v\nwant=%+v", fileStates, fixture.State.FileStates)
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("avatar-delete fixture has no response %q", label)
		}
		assertAvatarResponse(t, "avatar-delete "+label, got, want)
	}
}

func snapshotAvatarDeleteState(t *testing.T, avatarsDirectory, thumbnailsDirectory string) avatarDeleteState {
	t.Helper()
	return avatarDeleteState{
		Avatars:    snapshotAvatarDeleteDirectory(t, avatarsDirectory),
		Thumbnails: snapshotAvatarDeleteDirectory(t, thumbnailsDirectory),
	}
}

func snapshotAvatarDeleteDirectory(t *testing.T, directory string) []avatarDeleteFileState {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	files := make([]avatarDeleteFileState, 0, len(entries))
	for _, entry := range entries {
		target := filepath.Join(directory, entry.Name())
		info, err := os.Stat(target)
		if err != nil {
			t.Fatal(err)
		}
		state := avatarDeleteFileState{Name: entry.Name(), Kind: "other"}
		switch {
		case info.IsDir():
			state.Kind = "directory"
		case info.Mode().IsRegular():
			state.Kind = "file"
			body, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(body)
			state.SHA256 = hex.EncodeToString(digest[:])
		}
		files = append(files, state)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files
}
