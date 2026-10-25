package server

// THE PERSONA AVATAR UPLOAD CONTRACT — source-derived (AGENTS.md rule 4).
//
// A capture cannot exist for this route: it needs an authenticated session, a real multipart body and a
// real image, and the pinned node-reference probe boots a server whose session it would have to forge.
// So this test is a DERIVATION from the pinned source, labelled as such, and every expectation below
// quotes the line it came from. Nothing here is derived from our implementation.
//
// Pinned `src/endpoints/avatars.js:41-65`:
//
//	router.post('/upload', getFileNameValidationFunction('overwrite_name'), async (request, response) => {
//	    if (!request.file) return response.sendStatus(400);
//	    const crop = tryParse(request.query.crop);
//	    const rawImg = await Jimp.read(pathToUpload);
//	    const image = await applyAvatarCropResize(rawImg, crop);
//	    if (request.body.overwrite_name) {
//	        invalidateThumbnail(request.user.directories, 'persona', sanitize(request.body.overwrite_name));
//	        cacheBuster.bust(request, response);
//	    }
//	    const filename = sanitize(request.body.overwrite_name || `${Date.now()}.png`);
//	    writeFileAtomicSync(path.join(request.user.directories.avatars, filename), image);
//	    fs.unlinkSync(pathToUpload);
//	    return response.send({ path: filename });
//	});
//
// The dependencies that carry the real behaviour, all read rather than assumed:
//   - `applyAvatarCropResize` (src/endpoints/characters.js:283-306): if `crop` is an object whose
//     x/y/width/height are all numbers, `image.crop({x,y,w,h})`, then final size is
//     AVATAR_WIDTH x AVATAR_HEIGHT (512x768, src/constants.js:358-359) when `crop.want_resize`, else
//     exactly crop.width x crop.height; finally `image.cover({w: finalWidth, h: finalHeight})` — so the
//     STORED DIMENSIONS are the observable that proves a crop was applied at all.
//   - `getFileNameValidationFunction` (src/middleware/validateFileName.js:19-41): rejects a string field
//     (or one with a toString) containing `/` or NUL — plus `\` where path.sep is a backslash — with
//     `res.sendStatus(400)` BEFORE the handler runs. `../x.png` contains `/`, so it is 400 and no file is
//     written.
//   - multer (src/server-main.js:269) is mounted GLOBALLY as
//     `multer({ dest: uploadsPath, limits: { fieldSize: 500 * 1024 * 1024 } }).single('avatar')`, so the
//     multipart field is literally named `avatar`, there is NO fileSize cap, and a request without a
//     multipart file leaves `request.file` undefined -> 400.
//   - `cacheBuster.bust` (src/middleware/cacheBuster.js:101-105) sets `Clear-Site-Data: "cache"` only when
//     `cacheBuster.enabled` is true, and that config defaults to FALSE (:28). The test therefore asserts
//     the disk-observable half (thumbnail invalidation) unconditionally and the header only where enabled.

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// avatarUploadFixture is the smallest real PNG that DECODES: a 2x2 image built by the test, never a
// recorded Jimp byte stream. The stored bytes are a pure-Go re-encode (ARCHITECTURE.md 35.2:
// "bytes differ (Jimp vs pure-Go codec), observable equal"), so every assertion below is about the
// observable -- status, JSON body, filename on disk, stored dimensions, thumbnail presence.
func avatarUploadPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			// A gradient, so a wrong crop is also a wrong PICTURE and not only a wrong size.
			canvas.Set(x, y, color.RGBA{R: uint8(x * 8), G: uint8(y * 8), B: 200, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, canvas); err != nil {
		t.Fatalf("encode fixture png: %v", err)
	}
	return encoded.Bytes()
}

// personaAvatarUploadHarness reuses the idiom of avatars_delete_test.go: seeded account record, cookie
// secret, EnsureDirectories, then a real handler with a real CSRF token and a real login session. No
// second auth path is invented.
type personaAvatarUploadHarness struct {
	handler             http.Handler
	sessionCookie       string
	csrfToken           string
	avatarsDirectory    string
	thumbnailsDirectory string
}

func newPersonaAvatarUploadHarness(t *testing.T) *personaAvatarUploadHarness {
	t.Helper()
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	const cookieSecret = "avatar-upload-probe-secret"
	accountJSON, err := marshalNodeJSON(struct {
		Handle   string         `json:"handle"`
		Name     string         `json:"name"`
		Created  int64          `json:"created"`
		Password string         `json:"password"`
		Admin    bool           `json:"admin"`
		Enabled  bool           `json:"enabled"`
		Salt     string         `json:"salt"`
		Unknown  map[string]any `json:"probeUnknownField"`
	}{"default-user", "Avatar Uploader", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	// A real install creates <dataRoot>/_uploads during startup's data-startup step, and the global
	// multer staging directory is where an upload is written before the route copies it. Every other
	// upload harness in this package seeds it for the same reason (backgrounds_upload_test.go:118,
	// characters_oracle_test.go:129, chats_import_test.go:95, worldinfo_test.go:195). Its absence here
	// made CreateUploadStagingFile fail, which the handler reported as the bare 400 pinned sends for
	// "no file" -- so every SUCCESS case read as a refusal while the forbidden-name case passed for
	// the wrong reason. Found by comparing this harness with the working route's.
	if err := os.MkdirAll(filepath.Join(dataRoot, "_uploads"), 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: cookieSecret,
		AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token string, body []byte, contentType string) *httptest.ResponseRecorder {
		t.Helper()
		var reader *bytes.Reader
		if body == nil {
			reader = bytes.NewReader(nil)
		} else {
			reader = bytes.NewReader(body)
		}
		request := httptest.NewRequest(method, route, reader)
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
	cookieFrom := func(cookies []string) string {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", nil, "")
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrfResponse.Code)
	}
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatal(err)
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, []byte(`{"handle":"default-user","password":""}`), "application/json")
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	return &personaAvatarUploadHarness{
		handler:             handler,
		sessionCookie:       cookieFrom(login.Header().Values("Set-Cookie")),
		csrfToken:           csrf.Token,
		avatarsDirectory:    directories["avatars"],
		thumbnailsDirectory: directories["thumbnailsPersona"],
	}
}

// uploadAvatar posts a real multipart body whose file field is named `avatar`, exactly as the pinned
// global multer instance expects (src/server-main.js:269).
func (harness *personaAvatarUploadHarness) uploadAvatar(t *testing.T, query string, fileBytes []byte, fileName string, overwriteName string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if fileBytes != nil {
		part, err := writer.CreateFormFile("avatar", fileName)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(fileBytes); err != nil {
			t.Fatal(err)
		}
	}
	if overwriteName != "" {
		if err := writer.WriteField("overwrite_name", overwriteName); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	route := "/api/avatars/upload"
	if query != "" {
		route += "?" + query
	}
	request := httptest.NewRequest(http.MethodPost, route, bytes.NewReader(body.Bytes()))
	request.Header.Set("Cookie", harness.sessionCookie)
	request.Header.Set("X-CSRF-Token", harness.csrfToken)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	harness.handler.ServeHTTP(response, request)
	return response
}

func storedImageDimensions(t *testing.T, path string) (int, int) {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open stored avatar %q: %v", path, err)
	}
	defer file.Close()
	decoded, _, err := image.Decode(file)
	if err != nil {
		t.Fatalf("stored avatar %q is not a decodable image: %v", path, err)
	}
	bounds := decoded.Bounds()
	return bounds.Dx(), bounds.Dy()
}

// TestPersonaAvatarUploadCreatesTheFile is the reason the lane exists: after this route works, a persona
// avatar can be CREATED, not only displayed. Today the route is not registered at all, so the UI's and
// persona.ts:203's upload path has no server to talk to.
func TestPersonaAvatarUploadCreatesTheFile(t *testing.T) {
	harness := newPersonaAvatarUploadHarness(t)
	source := avatarUploadPNG(t, 8, 6)

	response := harness.uploadAvatar(t, "", source, "source.png", "")
	if response.Code != http.StatusOK {
		t.Fatalf("POST /api/avatars/upload = %d, want 200 (body %q); pinned avatars.js:41-65 answers 200 with {path}", response.Code, response.Body.String())
	}
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("response %q is not JSON: %v", response.Body.String(), err)
	}
	if payload.Path == "" {
		t.Fatalf("response %q has no path member; pinned sends {path: filename}", response.Body.String())
	}
	if !strings.HasSuffix(payload.Path, ".png") {
		t.Fatalf("path = %q, want the pinned default `${Date.now()}.png`", payload.Path)
	}
	stored := filepath.Join(harness.avatarsDirectory, payload.Path)
	if _, err := os.Stat(stored); err != nil {
		t.Fatalf("the reported path %q was not written under User Avatars: %v", payload.Path, err)
	}
	// No crop and no want_resize: applyAvatarCropResize covers to the ORIGINAL dimensions, so a correct
	// implementation stores an image of the source's size. A wrong crop shows up here.
	if width, height := storedImageDimensions(t, stored); width != 8 || height != 6 {
		t.Fatalf("stored avatar = %dx%d, want the source 8x6 (characters.js:283-306 keeps final size = original when crop is absent)", width, height)
	}
}

// TestPersonaAvatarUploadHonoursOverwriteName covers the deterministic-name branch, which is what a helper
// script (persona.ts:203) and the frontend both use to replace an existing persona image.
func TestPersonaAvatarUploadHonoursOverwriteName(t *testing.T) {
	harness := newPersonaAvatarUploadHarness(t)
	response := harness.uploadAvatar(t, "", avatarUploadPNG(t, 4, 4), "source.png", "me.png")
	if response.Code != http.StatusOK {
		t.Fatalf("upload with overwrite_name = %d, want 200 (body %q)", response.Code, response.Body.String())
	}
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Path != "me.png" {
		t.Fatalf("path = %q, want the exact overwrite_name %q (avatars.js:56 sanitizes but does not rename)", payload.Path, "me.png")
	}
	if _, err := os.Stat(filepath.Join(harness.avatarsDirectory, "me.png")); err != nil {
		t.Fatalf("me.png was not written under User Avatars: %v", err)
	}
}

// TestPersonaAvatarUploadAppliesCrop proves the crop parameter reaches the image rather than being
// accepted and ignored: the stored DIMENSIONS are crop.width x crop.height, because applyAvatarCropResize
// sets final size from the crop and then covers to it (characters.js:292-304).
func TestPersonaAvatarUploadAppliesCrop(t *testing.T) {
	harness := newPersonaAvatarUploadHarness(t)
	crop := url.QueryEscape(`{"x":0,"y":0,"width":5,"height":3}`)
	response := harness.uploadAvatar(t, "crop="+crop, avatarUploadPNG(t, 16, 12), "source.png", "cropped.png")
	if response.Code != http.StatusOK {
		t.Fatalf("upload with crop = %d, want 200 (body %q)", response.Code, response.Body.String())
	}
	stored := filepath.Join(harness.avatarsDirectory, "cropped.png")
	if width, height := storedImageDimensions(t, stored); width != 5 || height != 3 {
		t.Fatalf("stored avatar = %dx%d, want 5x3: the crop query parameter was not applied (characters.js:292-304)", width, height)
	}
}

// TestPersonaAvatarUploadRejectsInvalidAndMissingFiles pins the two refusal branches. They stay
// distinguishable from "not implemented" precisely because the route exists (rule 17).
func TestPersonaAvatarUploadRejectsInvalidAndMissingFiles(t *testing.T) {
	harness := newPersonaAvatarUploadHarness(t)

	missing := harness.uploadAvatar(t, "", nil, "", "")
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("upload with no file = %d, want 400 (avatars.js:42 `if (!request.file) return sendStatus(400)`)", missing.Code)
	}

	invalid := harness.uploadAvatar(t, "", []byte("this is not an image"), "not-an-image.png", "")
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("upload of a non-image = %d, want 400 (avatars.js:61-63 catch -> 400)", invalid.Code)
	}
	if body := invalid.Body.String(); body != "Is not a valid image" {
		t.Fatalf("body = %q, want the pinned literal %q", body, "Is not a valid image")
	}
	if entries, err := os.ReadDir(harness.avatarsDirectory); err == nil {
		for _, entry := range entries {
			if entry.Name() == "not-an-image.png" {
				t.Fatal("a rejected upload was stored under User Avatars")
			}
		}
	}
}

// TestPersonaAvatarUploadRejectsAForbiddenName pins the MIDDLEWARE branch, which runs before the handler:
// validateFileName.js:28-35 tests the field against /[/\x00]/ (plus `\` on Windows) and answers 400.
// `../x.png` contains `/`, so it is refused even though the sanitizer would also have changed it.
func TestPersonaAvatarUploadRejectsAForbiddenName(t *testing.T) {
	harness := newPersonaAvatarUploadHarness(t)
	response := harness.uploadAvatar(t, "", avatarUploadPNG(t, 4, 4), "source.png", "../x.png")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("upload with overwrite_name %q = %d, want 400 (validateFileName.js:28-35)", "../x.png", response.Code)
	}
	if _, err := os.Stat(filepath.Join(harness.avatarsDirectory, "..", "x.png")); err == nil {
		t.Fatal("a path-traversing overwrite_name escaped the avatars directory")
	}
}

// TestPersonaAvatarUploadInvalidatesThePersonaThumbnail is the disk-observable half of avatars.js:51-54.
// pinned calls invalidateThumbnail(..., 'persona', sanitize(overwrite_name)) BEFORE writing, so a stale
// thumbnail must not survive an overwrite. This is the assertion a "return 200 without doing the work"
// implementation cannot fake.
func TestPersonaAvatarUploadInvalidatesThePersonaThumbnail(t *testing.T) {
	harness := newPersonaAvatarUploadHarness(t)
	thumbnail := filepath.Join(harness.thumbnailsDirectory, "me.png")
	if err := os.WriteFile(thumbnail, []byte("stale thumbnail bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := harness.uploadAvatar(t, "", avatarUploadPNG(t, 4, 4), "source.png", "me.png")
	if response.Code != http.StatusOK {
		t.Fatalf("upload = %d, want 200", response.Code)
	}
	if _, err := os.Stat(thumbnail); !os.IsNotExist(err) {
		t.Fatalf("the persona thumbnail survived the overwrite (stat err = %v); avatars.js:52 invalidates it before writing", err)
	}
}
