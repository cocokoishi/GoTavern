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

type imageMetadataFolderAssignmentCase struct {
	Index string          `json:"index"`
	Body  json.RawMessage `json:"body"`
}

type imageMetadataFolderAssignmentsFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret  string                                       `json:"cookieSecret"`
		Indexes       map[string]json.RawMessage                   `json:"indexes"`
		AssignCases   map[string]imageMetadataFolderAssignmentCase `json:"assignCases"`
		UnassignCases map[string]imageMetadataFolderAssignmentCase `json:"unassignCases"`
		GoRoundTrip   struct {
			Index        string          `json:"index"`
			AssignBody   json.RawMessage `json:"assignBody"`
			UnassignBody json.RawMessage `json:"unassignBody"`
		} `json:"goRoundTripInput"`
	} `json:"inputs"`
	Responses struct {
		Assign   map[string]accountMutationResponseFixture `json:"assign"`
		Unassign map[string]accountMutationResponseFixture `json:"unassign"`
	} `json:"responses"`
	State struct {
		AssignFileContentsAfter   map[string]*string `json:"assignFileContentsAfter"`
		UnassignFileContentsAfter map[string]*string `json:"unassignFileContentsAfter"`
		AccountRecordUnchanged    bool               `json:"accountRecordUnchanged"`
		GoRoundTrip               struct {
			GoAssignResponse         accountMutationResponseFixture `json:"goAssignResponse"`
			NodeFoldersAfterAssign   accountMutationResponseFixture `json:"nodeFoldersAfterAssign"`
			NodeIndexAfterAssign     accountMutationResponseFixture `json:"nodeIndexAfterAssign"`
			FileAfterAssign          string                         `json:"fileAfterAssign"`
			GoUnassignResponse       accountMutationResponseFixture `json:"goUnassignResponse"`
			NodeFoldersAfterUnassign accountMutationResponseFixture `json:"nodeFoldersAfterUnassign"`
			NodeIndexAfterUnassign   accountMutationResponseFixture `json:"nodeIndexAfterUnassign"`
			FileAfterUnassign        string                         `json:"fileAfterUnassign"`
		} `json:"goRoundTrip"`
	} `json:"state"`
}

func TestPinnedNodeImageMetadataFolderAssignments(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-image-metadata-folder-assignments.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture imageMetadataFolderAssignmentsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("image-metadata folder-assignments oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Indexes) == 0 || len(fixture.Inputs.AssignCases) == 0 || len(fixture.Inputs.UnassignCases) == 0 {
		t.Fatal("image-metadata folder-assignments oracle is missing required inputs")
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
	}{"default-user", "Image Metadata Folder Assignment Admin", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	indexPath := filepath.Join(directories["root"], imageMetadataIndexFilename)
	backgroundsRoot := filepath.Join(directories["root"], "backgrounds")
	if err := os.MkdirAll(filepath.Join(backgroundsRoot, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{"forest.webp", "new.webp", "rebuild.webp", "tree.png"} {
		if err := os.WriteFile(filepath.Join(backgroundsRoot, filename), []byte("probe image data"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true})
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
	responses := map[string]map[string]*httptest.ResponseRecorder{"assign": {}, "unassign": {}}
	for _, operation := range []string{"assign", "unassign"} {
		route := "/api/image-metadata/folders/" + operation
		responses[operation]["unauthorized"] = serve(http.MethodPost, route, csrfCookie, csrf.Token, []byte(`{"id":"alpha","paths":[]}`))
		responses[operation]["invalidCSRF"] = serve(http.MethodPost, route, sessionCookie, "", []byte(`{"id":"alpha","paths":[]}`))
		responses[operation]["wrongMethod"] = serve(http.MethodGet, route, sessionCookie, "", nil)
		responses[operation]["wrongMethodHead"] = serve(http.MethodHead, route, sessionCookie, "", nil)
		responses[operation]["wrongMethodOptions"] = serve(http.MethodOptions, route, sessionCookie, "", nil)
	}

	fileStatePath := func() *string {
		t.Helper()
		body, err := os.ReadFile(indexPath)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			t.Fatal(err)
		}
		value := string(body)
		return &value
	}
	runCases := func(operation string, cases map[string]imageMetadataFolderAssignmentCase, expected map[string]accountMutationResponseFixture, state map[string]*string) {
		t.Helper()
		route := "/api/image-metadata/folders/" + operation
		for label, probeRequest := range cases {
			rawIndex, exists := fixture.Inputs.Indexes[probeRequest.Index]
			if !exists {
				t.Fatalf("%s case %q references missing index fixture %q", operation, label, probeRequest.Index)
			}
			if bytes.Equal(bytes.TrimSpace(rawIndex), []byte("null")) {
				if err := os.Remove(indexPath); err != nil && !os.IsNotExist(err) {
					t.Fatal(err)
				}
			} else {
				var content string
				if err := json.Unmarshal(rawIndex, &content); err != nil {
					t.Fatalf("decode %s %s index input: %v", operation, label, err)
				}
				if err := os.WriteFile(indexPath, []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			got := serve(http.MethodPost, route, sessionCookie, csrf.Token, probeRequest.Body)
			assertImageMetadataFolderAssignmentResponse(t, operation+" "+label, got, expected[label])
			gotContent := fileStatePath()
			wantContent, hasWant := state[label]
			if !hasWant || !reflect.DeepEqual(gotContent, wantContent) {
				t.Fatalf("%s index after %s = %#v; pinned Node has %#v", operation, label, gotContent, wantContent)
			}
		}
		for label, got := range responses[operation] {
			want, exists := expected[label]
			if !exists {
				t.Fatalf("%s fixture has no response %q", operation, label)
			}
			assertImageMetadataFolderAssignmentResponse(t, operation+" "+label, got, want)
		}
	}
	runCases("assign", fixture.Inputs.AssignCases, fixture.Responses.Assign, fixture.State.AssignFileContentsAfter)
	runCases("unassign", fixture.Inputs.UnassignCases, fixture.Responses.Unassign, fixture.State.UnassignFileContentsAfter)

	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.GoRoundTrip.Index), 0o600); err != nil {
		t.Fatal(err)
	}
	assignBody := fixture.Inputs.GoRoundTrip.AssignBody
	goAssign := serve(http.MethodPost, "/api/image-metadata/folders/assign", sessionCookie, csrf.Token, assignBody)
	assertImageMetadataFolderAssignmentResponse(t, "Go assign round trip", goAssign, fixture.State.GoRoundTrip.GoAssignResponse)
	foldersAfterAssign := serve(http.MethodPost, "/api/image-metadata/folders/get", sessionCookie, csrf.Token, []byte(`{}`))
	assertImageMetadataFolderAssignmentResponse(t, "Node folder list after Go assign", foldersAfterAssign, fixture.State.GoRoundTrip.NodeFoldersAfterAssign)
	indexAfterAssign := serve(http.MethodPost, "/api/image-metadata/all", sessionCookie, csrf.Token, []byte(`{}`))
	assertImageMetadataFolderAssignmentResponse(t, "Node index after Go assign", indexAfterAssign, fixture.State.GoRoundTrip.NodeIndexAfterAssign)
	if got := fileStatePath(); got == nil || *got != fixture.State.GoRoundTrip.FileAfterAssign {
		t.Fatalf("metadata index after Go assign = %#v; pinned Node has %q", got, fixture.State.GoRoundTrip.FileAfterAssign)
	}
	goUnassign := serve(http.MethodPost, "/api/image-metadata/folders/unassign", sessionCookie, csrf.Token, fixture.Inputs.GoRoundTrip.UnassignBody)
	assertImageMetadataFolderAssignmentResponse(t, "Go unassign round trip", goUnassign, fixture.State.GoRoundTrip.GoUnassignResponse)
	foldersAfterUnassign := serve(http.MethodPost, "/api/image-metadata/folders/get", sessionCookie, csrf.Token, []byte(`{}`))
	assertImageMetadataFolderAssignmentResponse(t, "Node folder list after Go unassign", foldersAfterUnassign, fixture.State.GoRoundTrip.NodeFoldersAfterUnassign)
	indexAfterUnassign := serve(http.MethodPost, "/api/image-metadata/all", sessionCookie, csrf.Token, []byte(`{}`))
	assertImageMetadataFolderAssignmentResponse(t, "Node index after Go unassign", indexAfterUnassign, fixture.State.GoRoundTrip.NodeIndexAfterUnassign)
	if got := fileStatePath(); got == nil || *got != fixture.State.GoRoundTrip.FileAfterUnassign {
		t.Fatalf("metadata index after Go unassign = %#v; pinned Node has %q", got, fixture.State.GoRoundTrip.FileAfterUnassign)
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("image-metadata assignments changed the account record")
	}
}

func assertImageMetadataFolderAssignmentResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	var gotBody any
	if got.Body.Len() > 0 {
		if err := json.Unmarshal(got.Body.Bytes(), &gotBody); err != nil {
			gotBody = got.Body.String()
		}
	}
	gotHeaders := stableAccountBackupHeaders(got.Header())
	if got.Code != want.Status || !reflect.DeepEqual(gotHeaders, want.Headers) || !reflect.DeepEqual(gotBody, want.Body) {
		t.Fatalf("image-metadata folder-assignment response %s differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", label, got.Code, want.Status, gotHeaders, want.Headers, gotBody, want.Body)
	}
}
