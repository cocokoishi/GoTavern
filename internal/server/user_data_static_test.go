package server

// Contract tests for the two USER DATA asset routes that LittleWhiteBox exposed as missing.
//
// These are SOURCE-DERIVED (rule 4), labelled as such, and they are the same shape as the
// `/backgrounds/*` test beside them: the oracle is the pinned source, not a capture, because the
// routes need a session and a data root.
//
//	src/users.js:1217  router.use('/user/images/*', createRouteHandler(req => req.user.directories.userImages));
//	src/users.js:1218  router.use('/user/files/*',  createRouteHandler(req => req.user.directories.files));
//
// createRouteHandler is users.js:1092-1112 (decoded capture, isPathUnderParent, existsSync, sendFile).
//
// WHAT THE MISSING ROUTES COST A USER, and why this test exists rather than only the E2E pair: an
// extension uploads a file through POST /api/files/upload (which worked) and reads it back through
// `/user/files/<name>?v=<cachebuster>` (which answered 404), so it could store state it could never
// load. The `?v=` parameter is a cache-buster the pinned route ignores, because it reads only the
// wildcard capture -- so a test that omits it would not have caught the defect the extension hit.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUserDataStaticMatchesPinnedCreateRouteHandler(t *testing.T) {
	harness := newFrontendAssetHarness(t)
	cases := []struct {
		name         string
		urlPrefix    string
		directoryKey string
		relative     string
		contentType  string
	}{
		{name: "userImages", urlPrefix: "/user/images", directoryKey: "userImages", relative: "user/images", contentType: "image/png"},
		{name: "userFiles", urlPrefix: "/user/files", directoryKey: "files", relative: "user/files", contentType: "application/json; charset=UTF-8"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			// The map KEY is not the directory: USER_DIRECTORY_TEMPLATE puts both trees under user/.
			directory := filepath.Join(harness.dataRoot, "default-user", filepath.FromSlash(testCase.relative))
			body := []byte(`{"probe":true}`)
			sample := "sample.png"
			if testCase.name == "userFiles" {
				sample = "sample.json"
			}
			if err := os.WriteFile(filepath.Join(directory, sample), body, 0o600); err != nil {
				t.Fatal(err)
			}

			// The cache-buster is the shape the frontend actually uses: `/user/files/x.json?v=<stamp>`.
			found := harness.get(t, testCase.urlPrefix+"/"+sample+"?v=1700000000000-abc123", true)
			if found.Code != http.StatusOK {
				t.Fatalf("GET %s/%s?v=... = %d, pinned serves the file (body %q)", testCase.urlPrefix, sample, found.Code, found.Body.String())
			}
			if found.Body.String() != string(body) {
				t.Fatalf("GET %s/%s body = %q, want %q", testCase.urlPrefix, sample, found.Body.String(), body)
			}
			for header, want := range map[string]string{
				"Content-Type":  testCase.contentType,
				"Accept-Ranges": "bytes",
				"Cache-Control": "public, max-age=0",
			} {
				if got := found.Header().Get(header); got != want {
					t.Fatalf("GET %s/%s %s = %q, pinned sends %q", testCase.urlPrefix, sample, header, got, want)
				}
			}
			if found.Header().Get("ETag") == "" || found.Header().Get("Last-Modified") == "" {
				t.Fatalf("GET %s/%s validators = ETag %q / Last-Modified %q; send() always sends both",
					testCase.urlPrefix, sample, found.Header().Get("ETag"), found.Header().Get("Last-Modified"))
			}

			// A nested capture is served from the same root.
			nested := filepath.Join(directory, "nested")
			if err := os.MkdirAll(nested, 0o777); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(nested, "deep.bin"), []byte("DEEP"), 0o600); err != nil {
				t.Fatal(err)
			}
			if deep := harness.get(t, testCase.urlPrefix+"/nested/deep.bin", true); deep.Code != http.StatusOK || deep.Body.String() != "DEEP" {
				t.Fatalf("GET %s/nested/deep.bin = %d body %q, pinned serves it", testCase.urlPrefix, deep.Code, deep.Body.String())
			}

			// createRouteHandler's miss is res.sendStatus(404): text/plain, NOT the application's 404 page.
			missing := harness.get(t, testCase.urlPrefix+"/absent.json", true)
			if missing.Code != http.StatusNotFound || !strings.HasPrefix(missing.Header().Get("Content-Type"), "text/plain") {
				t.Fatalf("GET %s/absent.json = %d %q, pinned answers 404 text/plain", testCase.urlPrefix, missing.Code, missing.Header().Get("Content-Type"))
			}
			if missing.Body.String() != "Not Found" {
				t.Fatalf("GET %s/absent.json body = %q, res.sendStatus sends %q", testCase.urlPrefix, missing.Body.String(), "Not Found")
			}

			// The private router: no session, no file.
			anonymous := harness.get(t, testCase.urlPrefix+"/"+sample, false)
			if anonymous.Code != http.StatusForbidden {
				t.Fatalf("anonymous GET %s/%s = %d, the pinned route requires a session", testCase.urlPrefix, sample, anonymous.Code)
			}

			// The containment refusal itself is defence in depth: net/http normalises `..` and `%2f`
			// before a handler runs (the same known gap extensions_static.go records), so it is
			// asserted at the handler rather than through the mux, where it is unreachable.
			traversal := httptest.NewRecorder()
			if servePinnedExtensionRoot(traversal, httptest.NewRequest(http.MethodGet, testCase.urlPrefix+"/x", nil), directory, "../secret.json", nil) {
				if traversal.Code != http.StatusForbidden {
					t.Fatalf("servePinnedExtensionRoot with the capture ../secret.json = %d, isPathUnderParent answers 403", traversal.Code)
				}
			} else {
				t.Fatalf("servePinnedExtensionRoot with the capture ../secret.json was not answered; it must refuse with 403")
			}
		})
	}
}
