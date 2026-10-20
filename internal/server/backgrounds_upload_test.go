package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type backgroundsUploadFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret           string `json:"cookieSecret"`
		ImageBytes             string `json:"imageBytes"`
		InitialBackgroundBytes string `json:"initialBackgroundBytes"`
		InitialIndex           string `json:"initialIndex"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		AfterOverwrite struct {
			Content         string   `json:"content"`
			ThumbnailExists bool     `json:"thumbnailExists"`
			Uploads         []string `json:"uploads"`
			Index           any      `json:"index"`
		} `json:"afterOverwrite"`
		AfterNodeUploads struct {
			SanitizedExists bool     `json:"sanitizedExists"`
			UnicodeExists   bool     `json:"unicodeExists"`
			Uploads         []string `json:"uploads"`
			Index           any      `json:"index"`
		} `json:"afterNodeUploads"`
		AfterThumbnailFailure struct {
			BackgroundExists         bool     `json:"backgroundExists"`
			ThumbnailDirectoryExists bool     `json:"thumbnailDirectoryExists"`
			Uploads                  []string `json:"uploads"`
			Index                    any      `json:"index"`
		} `json:"afterThumbnailFailure"`
		GoRoundTrip struct {
			NodeResponse       accountMutationResponseFixture `json:"nodeResponse"`
			GoResponse         accountMutationResponseFixture `json:"goResponse"`
			NodeReadbackStatus int                            `json:"nodeReadbackStatus"`
			NodeReadbackIndex  any                            `json:"nodeReadbackIndex"`
			GoIndex            any                            `json:"goIndex"`
			Content            string                         `json:"content"`
			Uploads            []string                       `json:"uploads"`
			NodeOracleIndex    any                            `json:"nodeOracleIndex"`
		} `json:"goRoundTrip"`
		AccountRecordUnchanged bool `json:"accountRecordUnchanged"`
	} `json:"state"`
}

func TestPinnedNodeBackgroundUpload(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-backgrounds-upload.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture backgroundsUploadFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("backgrounds/upload oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || fixture.Inputs.ImageBytes == "" || fixture.Inputs.InitialBackgroundBytes == "" || fixture.Inputs.InitialIndex == "" {
		t.Fatal("backgrounds/upload oracle is missing required inputs")
	}
	if fixture.State.GoRoundTrip.NodeReadbackStatus != http.StatusOK || !reflect.DeepEqual(fixture.State.GoRoundTrip.NodeReadbackIndex, fixture.State.GoRoundTrip.GoIndex) {
		t.Fatal("pinned Node readback of Go upload does not match the observed Go-written index")
	}
	if !reflect.DeepEqual(fixture.State.GoRoundTrip.NodeOracleIndex, fixture.State.GoRoundTrip.NodeReadbackIndex) {
		t.Fatal("pinned Node upload oracle and Go upload readback metadata differ")
	}
	if !reflect.DeepEqual(fixture.State.GoRoundTrip.NodeResponse, fixture.State.GoRoundTrip.GoResponse) {
		t.Fatal("Go upload response captured by the oracle differs from pinned Node")
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
	}{"default-user", "Background Upload Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	if err := os.MkdirAll(filepath.Join(dataRoot, "_uploads"), 0o777); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	backgroundsRoot := directories["backgrounds"]
	thumbnailRoot := directories["thumbnailsBg"]
	imageBytes, err := base64.StdEncoding.DecodeString(fixture.Inputs.ImageBytes)
	if err != nil {
		t.Fatal(err)
	}
	initialBackgroundBytes, err := base64.StdEncoding.DecodeString(fixture.Inputs.InitialBackgroundBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backgroundsRoot, "overwrite.png"), initialBackgroundBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(thumbnailRoot, "overwrite.png"), []byte("cached thumbnail"), 0o600); err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(directories["root"], imageMetadataIndexFilename)
	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.InitialIndex), 0o600); err != nil {
		t.Fatal(err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token, contentType string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
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
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, "application/json", []byte(`{"handle":"default-user","password":""}`))
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))
	route := "/api/backgrounds/upload"
	missingFileBody, missingFileType := backgroundUploadMultipart(t, "", "", nil, true)
	wrongFieldBody, wrongFieldType := backgroundUploadMultipart(t, "image", "wrong-field.png", imageBytes, false)
	validBody, validType := backgroundUploadMultipart(t, "avatar", "overwrite.png", imageBytes, false)
	sanitizedBody, sanitizedType := backgroundUploadMultipart(t, "avatar", "adventure?land.png", imageBytes, false)
	unicodeBody, unicodeType := backgroundUploadMultipart(t, "avatar", "森の背景.png", imageBytes, false)
	thumbnailFailureBody, thumbnailFailureType := backgroundUploadMultipart(t, "avatar", "thumbnail-fail.png", imageBytes, false)
	goRoundTripBody, goRoundTripType := backgroundUploadMultipart(t, "avatar", "go-roundtrip.png", imageBytes, false)
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       serve(http.MethodPost, route, csrfCookie, csrf.Token, validType, validBody),
		"invalidCSRF":        serve(http.MethodPost, route, sessionCookie, "", validType, validBody),
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", "", nil),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", "", nil),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", "", nil),
		"missingFile":        serve(http.MethodPost, route, sessionCookie, csrf.Token, missingFileType, missingFileBody),
		"wrongFileField":     serve(http.MethodPost, route, sessionCookie, csrf.Token, wrongFieldType, wrongFieldBody),
	}
	for label, response := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("backgrounds/upload fixture has no %q response", label)
		}
		if label == "wrongFileField" {
			if response.Code != want.Status {
				t.Errorf("%s status = %d; pinned Node has %d", label, response.Code, want.Status)
			}
			continue
		}
		assertAccountMutationResponse(t, label, response, want)
	}

	post := func(body []byte, contentType string) *httptest.ResponseRecorder {
		return serve(http.MethodPost, route, sessionCookie, csrf.Token, contentType, body)
	}
	overwrite := post(validBody, validType)
	assertAccountMutationResponse(t, "overwrite upload", overwrite, fixture.Responses["overwrite"])
	assertBackgroundUploadState(t, "after overwrite", dataRoot, indexPath, fixture.State.AfterOverwrite.Index)
	if got := readUploadBase64(t, filepath.Join(backgroundsRoot, "overwrite.png")); got != fixture.State.AfterOverwrite.Content {
		t.Fatalf("overwritten background bytes differ from pinned Node: got %q", got)
	}
	if backgroundUploadPathExists(filepath.Join(thumbnailRoot, "overwrite.png")) != fixture.State.AfterOverwrite.ThumbnailExists {
		t.Fatal("overwrite thumbnail state differs from pinned Node")
	}

	sanitized := post(sanitizedBody, sanitizedType)
	assertAccountMutationResponse(t, "sanitized filename upload", sanitized, fixture.Responses["sanitizedFilename"])
	unicode := post(unicodeBody, unicodeType)
	assertAccountMutationResponse(t, "Unicode filename upload", unicode, fixture.Responses["unicodeFilename"])
	assertBackgroundUploadState(t, "after uploads", dataRoot, indexPath, fixture.State.AfterNodeUploads.Index)
	if backgroundUploadPathExists(filepath.Join(backgroundsRoot, "adventureland.png")) != fixture.State.AfterNodeUploads.SanitizedExists ||
		backgroundUploadPathExists(filepath.Join(backgroundsRoot, "森の背景.png")) != fixture.State.AfterNodeUploads.UnicodeExists {
		t.Fatal("sanitized or Unicode upload path state differs from pinned Node")
	}

	if err := os.Mkdir(filepath.Join(thumbnailRoot, "thumbnail-fail.png"), 0o755); err != nil {
		t.Fatal(err)
	}
	thumbnailFailure := post(thumbnailFailureBody, thumbnailFailureType)
	assertAccountMutationResponse(t, "thumbnail invalidation failure", thumbnailFailure, fixture.Responses["thumbnailFailure"])
	if backgroundUploadPathExists(filepath.Join(backgroundsRoot, "thumbnail-fail.png")) != fixture.State.AfterThumbnailFailure.BackgroundExists ||
		backgroundUploadDirectoryExists(filepath.Join(thumbnailRoot, "thumbnail-fail.png")) != fixture.State.AfterThumbnailFailure.ThumbnailDirectoryExists {
		t.Fatal("thumbnail failure operation ordering differs from pinned Node")
	}
	assertBackgroundUploadState(t, "after thumbnail failure", dataRoot, indexPath, fixture.State.AfterThumbnailFailure.Index)

	goRoundTrip := post(goRoundTripBody, goRoundTripType)
	assertAccountMutationResponse(t, "Go upload response", goRoundTrip, fixture.State.GoRoundTrip.NodeResponse)
	if got := readUploadBase64(t, filepath.Join(backgroundsRoot, "go-roundtrip.png")); got != fixture.State.GoRoundTrip.Content {
		t.Fatal("Go upload content differs from pinned Node")
	}
	assertBackgroundUploadState(t, "Go upload Node readback", dataRoot, indexPath, fixture.State.GoRoundTrip.NodeReadbackIndex)
	if !reflect.DeepEqual(readNormalizedUploadIndex(t, indexPath), fixture.State.GoRoundTrip.GoIndex) {
		t.Fatal("Go-written metadata index differs from the pinned Node readback")
	}

	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("background upload changed the account storage record")
	}
}

func backgroundUploadMultipart(t *testing.T, field, filename string, content []byte, noFile bool) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if noFile {
		if err := writer.WriteField("note", "no file is attached"); err != nil {
			t.Fatal(err)
		}
	} else {
		part, err := writer.CreateFormFile(field, filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes(), writer.FormDataContentType()
}

func assertBackgroundUploadState(t *testing.T, label, dataRoot, indexPath string, expectedIndex any) {
	t.Helper()
	if got := uploadDirectoryEntries(t, filepath.Join(dataRoot, "_uploads")); len(got) != 0 {
		t.Errorf("%s left staged upload files: %v", label, got)
	}
	if got := readNormalizedUploadIndex(t, indexPath); !reflect.DeepEqual(got, expectedIndex) {
		t.Errorf("%s metadata index = %#v; pinned Node has %#v", label, got, expectedIndex)
	}
}

func uploadDirectoryEntries(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	result := make([]string, len(entries))
	for index, entry := range entries {
		result[index] = entry.Name()
	}
	return result
}

func readNormalizedUploadIndex(t *testing.T, filename string) any {
	t.Helper()
	contents, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	var index map[string]any
	if err := json.Unmarshal(contents, &index); err != nil {
		t.Fatal(err)
	}
	images, ok := index["images"].(map[string]any)
	if ok {
		for _, rawMetadata := range images {
			metadata, ok := rawMetadata.(map[string]any)
			if !ok {
				continue
			}
			for _, key := range []string{"addedTimestamp", "mtime"} {
				if _, ok := metadata[key].(float64); ok {
					metadata[key] = "__" + strings.ToUpper(key) + "__"
				}
			}
		}
	}
	return index
}

func readUploadBase64(t *testing.T, filename string) string {
	t.Helper()
	contents, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(contents)
}

func backgroundUploadPathExists(filename string) bool {
	_, err := os.Stat(filename)
	return err == nil
}

func backgroundUploadDirectoryExists(filename string) bool {
	info, err := os.Stat(filename)
	return err == nil && info.IsDir()
}
