package server

// Pinned built-in extension discovery on a fresh install, and the second-order
// effect of answering it from the embedded tree.
//
// The finding this file pins: a release-shaped install (the binary, the
// launcher, LICENSE, THIRD_PARTY_NOTICES, tokenizers/ and BUILD-INFO, and no
// public/) listed ZERO built-in extensions, so the pinned frontend loaded none
// of them. Two independent measurements made it concrete:
//
//   - disk: startup mirrors pinned ensurePublicDirectoriesExist
//     (src/users.js:113-118), so the release layout gets an EMPTY
//     <InstallRoot>/public/scripts/extensions/third-party and nothing else in
//     <InstallRoot>/public/scripts/extensions;
//   - wire: /api/extensions/discover answered 200 with body [].
//
// The oracle is tests/oracle/sillytavern-1.19.0-extensions-discovery.json,
// recorded by tools/probe-extensions-discovery.mjs from the pinned server
// answering the same route on a fresh install with no seeded extensions. It
// also carries the pinned checkout's files and byte digests for every name the
// list contains, so the "the files behind every name exist" claim is compared
// against upstream bytes rather than against the embedded tree describing
// itself.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/upstream"
)

type extensionsDiscoveryEntry struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

type extensionsDiscoveryFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Normalizations []string `json:"normalizations"`
	Gaps           []string `json:"gaps"`
	Inputs         struct {
		CookieSecret     string           `json:"cookieSecret"`
		Config           string           `json:"config"`
		SeededUsers      []map[string]any `json:"seededUsers"`
		StaticProbeFiles []string         `json:"staticProbeFiles"`
	} `json:"inputs"`
	Discovery struct {
		Status  int                        `json:"status"`
		Headers map[string]string          `json:"headers"`
		Entries []extensionsDiscoveryEntry `json:"entries"`
	} `json:"discovery"`
	SystemExtensions []struct {
		Name  string `json:"name"`
		Files []struct {
			Path   string `json:"path"`
			Sha256 string `json:"sha256"`
		} `json:"files"`
	} `json:"systemExtensions"`
	StaticFiles []struct {
		Path       string            `json:"path"`
		Status     int               `json:"status"`
		Headers    map[string]string `json:"headers"`
		BodySha256 string            `json:"bodySha256"`
		BodyLength int               `json:"bodyLength"`
	} `json:"staticFiles"`
	Extra struct {
		UserExtensionsDirectoryRecreated bool `json:"userExtensionsDirectoryRecreated"`
		AnonymousManifestStatus          int  `json:"anonymousManifestStatus"`
		SystemCount                      int  `json:"systemCount"`
		SystemFileCount                  int  `json:"systemFileCount"`
	} `json:"extra"`
}

func loadExtensionsDiscoveryFixture(t *testing.T) extensionsDiscoveryFixture {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-extensions-discovery.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture extensionsDiscoveryFixture
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("extensions discovery oracle baseline = %+v", fixture.Baseline)
	}
	// A fixture without a system list would let every comparison below pass by
	// agreeing on emptiness, which is the very defect this file exists to catch.
	if len(fixture.Discovery.Entries) == 0 || len(fixture.SystemExtensions) == 0 || len(fixture.StaticFiles) == 0 {
		t.Fatal("extensions discovery oracle records an empty system list, so it could not distinguish a working install from the defect")
	}
	if len(fixture.Normalizations) == 0 {
		t.Fatal("extensions discovery oracle is missing its normalizations")
	}
	return fixture
}

// extensionsDiscoveryInstall is one release-shaped runtime: a fresh InstallRoot
// with no public/ tree, a fresh DataRoot and a logged-in session.
type extensionsDiscoveryInstall struct {
	t           *testing.T
	handler     http.Handler
	installRoot string
	dataRoot    string
	cookie      string
	token       string
}

func newExtensionsDiscoveryInstall(t *testing.T, fixture extensionsDiscoveryFixture) *extensionsDiscoveryInstall {
	t.Helper()
	runtimeRoot := t.TempDir()
	installRoot := filepath.Join(runtimeRoot, "install")
	if err := os.MkdirAll(installRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	dataRoot := filepath.Join(runtimeRoot, "data")
	if err := os.MkdirAll(filepath.Join(dataRoot, "_storage"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	handles := make([]string, 0, len(fixture.Inputs.SeededUsers))
	for _, user := range fixture.Inputs.SeededUsers {
		handle, _ := user["handle"].(string)
		if handle == "" {
			t.Fatalf("seeded user has no handle: %v", user)
		}
		encoded, err := marshalNodeJSON(user)
		if err != nil {
			t.Fatal(err)
		}
		if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+handle, encoded); err != nil {
			t.Fatal(err)
		}
		handles = append(handles, handle)
	}
	// The real startup path, so the InstallRoot is exactly what a release install
	// has: startup creates every pinned PUBLIC_DIRECTORIES entry, including the
	// empty public/scripts/extensions and its empty third-party container.
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, handles); err != nil {
		t.Fatal(err)
	}
	install := &extensionsDiscoveryInstall{
		t:           t,
		installRoot: installRoot,
		dataRoot:    dataRoot,
		handler: NewHTTPHandlerWithOptions(HTTPHandlerOptions{
			InstallRoot: installRoot, DataRoot: dataRoot,
			CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
		}),
	}
	install.login(handles[0])
	return install
}

func (install *extensionsDiscoveryInstall) serve(method, route, cookie, token, contentType string, body []byte) *httptest.ResponseRecorder {
	install.t.Helper()
	request := httptest.NewRequest(method, route, strings.NewReader(string(body)))
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
	install.handler.ServeHTTP(response, request)
	return response
}

func (install *extensionsDiscoveryInstall) login(handle string) {
	t := install.t
	t.Helper()
	csrf := install.serve(http.MethodGet, "/csrf-token", "", "", "", nil)
	if csrf.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrf.Code)
	}
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrf.Body.Bytes(), &token); err != nil {
		t.Fatal(err)
	}
	csrfCookie := joinCookieValues(csrf.Header().Values("Set-Cookie"))
	body, _ := json.Marshal(map[string]string{"handle": handle, "password": ""})
	response := install.serve(http.MethodPost, "/api/users/login", csrfCookie, token.Token, "application/json", body)
	if response.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login as %s = %d, body %q", handle, response.Code, response.Body.String())
	}
	install.token = token.Token
	install.cookie = joinCookieValues(response.Header().Values("Set-Cookie"))
}

// extensionsDiscoveryHeaders mirrors the probe's recorded header set: headers
// that belong to the connection, the clock or the session are not compared, and
// neither are ETag and Last-Modified, which send() derives from stat().mtime and
// which a response served from the embedded tree cannot carry (static.go:46-52).
func extensionsDiscoveryHeaders(header http.Header) map[string]string {
	skipped := map[string]bool{
		"connection": true, "date": true, "keep-alive": true, "transfer-encoding": true,
		"etag": true, "last-modified": true, "set-cookie": true, "x-response-time": true,
	}
	result := make(map[string]string)
	for name, values := range header {
		lower := strings.ToLower(name)
		if skipped[lower] {
			continue
		}
		result[lower] = strings.Join(values, ", ")
	}
	return result
}

func joinCookieValues(values []string) string {
	parts := make([]string, 0, len(values))
	for _, cookie := range values {
		parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
	}
	return strings.Join(parts, "; ")
}

// extensionsDiscoverySortKey mirrors the probe's per-group normalization:
// pinned's readdirSync order is a filesystem property, so the comparison is
// order-insensitive inside each pinned group.
func sortedExtensionsDiscoveryEntries(entries []extensionsDiscoveryEntry) []extensionsDiscoveryEntry {
	result := make([]extensionsDiscoveryEntry, len(entries))
	copy(result, entries)
	sort.SliceStable(result, func(left, right int) bool {
		if result[left].Type != result[right].Type {
			return result[left].Type < result[right].Type
		}
		return result[left].Name < result[right].Name
	})
	return result
}

func decodeExtensionsDiscoveryEntries(t *testing.T, response *httptest.ResponseRecorder) []extensionsDiscoveryEntry {
	t.Helper()
	var entries []extensionsDiscoveryEntry
	if err := json.Unmarshal(response.Body.Bytes(), &entries); err != nil {
		t.Fatalf("decode /api/extensions/discover body %q: %v", response.Body.String(), err)
	}
	return entries
}

// compareExtensionsDiscovery asserts one /api/extensions/discover observation
// against the pinned recording, and returns the system names it saw.
func compareExtensionsDiscovery(t *testing.T, label string, response *httptest.ResponseRecorder, fixture extensionsDiscoveryFixture) []string {
	t.Helper()
	if response.Code != fixture.Discovery.Status {
		t.Fatalf("%s: /api/extensions/discover = %d; pinned Node has %d (body %s)", label, response.Code, fixture.Discovery.Status, response.Body.String())
	}
	if got, want := extensionsDiscoveryHeaders(response.Result().Header), fixture.Discovery.Headers; !reflect.DeepEqual(got, want) {
		t.Errorf("%s: headers = %s; pinned Node has %s", label, formatAny(got), formatAny(want))
	}
	entries := decodeExtensionsDiscoveryEntries(t, response)
	if got, want := sortedExtensionsDiscoveryEntries(entries), sortedExtensionsDiscoveryEntries(fixture.Discovery.Entries); !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: entries = %s; pinned Node has %s", label, formatAny(got), formatAny(want))
	}
	// The pinned grouping is preserved even though the comparison is
	// order-insensitive inside a group, and a fresh install has only the system
	// group.
	names := make([]string, 0, len(entries))
	for index, entry := range entries {
		if entry.Type != "system" {
			t.Fatalf("%s: entry %d is %q, but the pinned fresh install lists only the system group", label, index, entry.Type)
		}
		names = append(names, entry.Name)
	}
	if len(names) == 0 {
		t.Fatalf("%s: the system list is empty, which is the release blocker itself", label)
	}
	return names
}

// TestPinnedExtensionDiscoverReleaseInstall is the release blocker's regression
// test. It FAILS before the embedded fallback existed: /api/extensions/discover
// answered `[]` for both layouts below, because the listing was read from an
// on-disk directory that a release install never populates.
func TestPinnedExtensionDiscoverReleaseInstall(t *testing.T) {
	fixture := loadExtensionsDiscoveryFixture(t)
	wantNames := make([]string, 0, len(fixture.SystemExtensions))
	for _, extension := range fixture.SystemExtensions {
		wantNames = append(wantNames, extension.Name)
	}
	sort.Strings(wantNames)

	t.Run("scaffold-created-by-startup", func(t *testing.T) {
		install := newExtensionsDiscoveryInstall(t, fixture)
		// The premise, asserted rather than assumed: this is the exact state a
		// release install is in after startup, and it is why reading from disk
		// alone can never answer.
		systemRoot := filepath.Join(install.installRoot, "public", "scripts", "extensions")
		entries, err := os.ReadDir(systemRoot)
		if err != nil {
			t.Fatalf("startup did not create %s, so this subtest is not the release layout: %v", systemRoot, err)
		}
		listable := 0
		for _, entry := range entries {
			if entry.Name() == "third-party" {
				continue
			}
			listable++
		}
		if listable != 0 {
			t.Fatalf("%s carries %d entries besides third-party, so this subtest is not the release layout", systemRoot, listable)
		}

		response := install.serve(http.MethodGet, "/api/extensions/discover", install.cookie, "", "", nil)
		gotNames := compareExtensionsDiscovery(t, "release scaffold", response, fixture)
		if len(gotNames) != len(fixture.SystemExtensions) {
			t.Fatalf("release scaffold: %d system extensions; pinned Node lists %d", len(gotNames), len(fixture.SystemExtensions))
		}
		if got, want := extensionsDiscoverySortedCopy(gotNames), wantNames; !reflect.DeepEqual(got, want) {
			t.Fatalf("release scaffold: system names = %s; pinned Node has %s", formatAny(got), formatAny(want))
		}
	})

	t.Run("no-public-tree-at-all", func(t *testing.T) {
		install := newExtensionsDiscoveryInstall(t, fixture)
		publicRoot := filepath.Join(install.installRoot, "public")
		if err := os.RemoveAll(publicRoot); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(publicRoot); !os.IsNotExist(err) {
			t.Fatalf("%s still exists after removal, so this subtest does not exercise a missing public tree", publicRoot)
		}

		response := install.serve(http.MethodGet, "/api/extensions/discover", install.cookie, "", "", nil)
		gotNames := compareExtensionsDiscovery(t, "missing public tree", response, fixture)
		if got, want := extensionsDiscoverySortedCopy(gotNames), wantNames; !reflect.DeepEqual(got, want) {
			t.Fatalf("missing public tree: system names = %s; pinned Node has %s", formatAny(got), formatAny(want))
		}
		// Pinned's /discover creates the global extensions directory with a
		// non-recursive mkdirSync, so it never creates the missing parent chain.
		// Answering the route must not do it either: a test that passed only
		// because the handler materialized an empty public/ tree would be a
		// fabricated success.
		if _, err := os.Stat(publicRoot); !os.IsNotExist(err) {
			t.Fatalf("GET /api/extensions/discover created %s; pinned would not create the missing parent chain from this route", publicRoot)
		}
	})
}

// TestPinnedExtensionDiscoverDiskWins pins the other half of the precedence:
// when the on-disk directory lists anything, it is authoritative and the
// embedded tree contributes nothing. Without this test the embedded fallback
// could be unconditional and every comparison above would still pass, because
// the pinned checkout's own built-ins and the embedded built-ins are the same
// names.
func TestPinnedExtensionDiscoverDiskWins(t *testing.T) {
	fixture := loadExtensionsDiscoveryFixture(t)
	install := newExtensionsDiscoveryInstall(t, fixture)
	systemRoot := filepath.Join(install.installRoot, "public", "scripts", "extensions")
	writeExtensionsFile(t, filepath.Join(systemRoot, "disk-only-probe", "manifest.json"), `{"display_name":"Disk Only Probe"}`)
	// A directory without a manifest is not a usable extension (extensions.js:489-503),
	// and a manifest inside the third-party container must not surface it as a
	// system extension (extensions.js:509 excludes the container before the
	// manifest filter).
	if err := os.MkdirAll(filepath.Join(systemRoot, "disk-only-nomanifest"), 0o777); err != nil {
		t.Fatal(err)
	}
	writeExtensionsFile(t, filepath.Join(systemRoot, "third-party", "manifest.json"), `{"display_name":"Third Party Container"}`)

	response := install.serve(http.MethodGet, "/api/extensions/discover", install.cookie, "", "", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("/api/extensions/discover = %d, body %s", response.Code, response.Body.String())
	}
	entries := decodeExtensionsDiscoveryEntries(t, response)
	want := []extensionsDiscoveryEntry{{Type: "system", Name: "disk-only-probe"}}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("system list = %s; the on-disk directory must win outright and pinned would list %s", formatAny(entries), formatAny(want))
	}
}

// TestPinnedExtensionStaticEmbeddedReleaseInstall covers the second-order
// effect of the fix: the frontend now requests /scripts/extensions/<built-in>/...
// for every name discovery reports, so the static middleware must answer them on
// a release-shaped install, from the embedded tree, with the pinned bytes and
// headers. It also answers the coverage question directly: does the embedded
// tree contain every built-in the list names, and every file behind it?
func TestPinnedExtensionStaticEmbeddedReleaseInstall(t *testing.T) {
	fixture := loadExtensionsDiscoveryFixture(t)
	install := newExtensionsDiscoveryInstall(t, fixture)
	publicRoot := filepath.Join(install.installRoot, "public")
	if err := os.RemoveAll(publicRoot); err != nil {
		t.Fatal(err)
	}

	type observedFile struct {
		path    string
		digest  string
		length  int
		headers map[string]string
	}
	observed := make(map[string]observedFile, len(fixture.StaticFiles))
	for _, recorded := range fixture.StaticFiles {
		response := install.serve(http.MethodGet, recorded.Path, install.cookie, "", "", nil)
		if response.Code != recorded.Status {
			t.Fatalf("GET %s = %d; pinned Node answers %d", recorded.Path, response.Code, recorded.Status)
		}
		headers := extensionsDiscoveryHeaders(response.Result().Header)
		if !reflect.DeepEqual(headers, recorded.Headers) {
			t.Errorf("GET %s headers = %s; pinned Node has %s", recorded.Path, formatAny(headers), formatAny(recorded.Headers))
		}
		body := response.Body.Bytes()
		digest := extensionsDiscoverySha256(body)
		if digest != recorded.BodySha256 {
			t.Fatalf("GET %s body sha256 = %s; pinned Node serves %s", recorded.Path, digest, recorded.BodySha256)
		}
		if len(body) != recorded.BodyLength {
			t.Fatalf("GET %s body length = %d; pinned Node serves %d", recorded.Path, len(body), recorded.BodyLength)
		}
		// The bytes must be the EMBEDDED asset, not a disk file that happens to be
		// there: the install root has no public tree.
		embedded, err := upstream.Assets.ReadFile("public" + recorded.Path)
		if err != nil {
			t.Fatalf("the embedded tree does not carry public%s, which the frontend requests for a built-in extension: %v", recorded.Path, err)
		}
		if extensionsDiscoverySha256(embedded) != digest {
			t.Fatalf("GET %s did not answer the embedded bytes", recorded.Path)
		}
		observed[recorded.Path] = observedFile{path: recorded.Path, digest: digest, length: len(body), headers: headers}
	}

	// Every built-in the discovery list names must have files behind it in the
	// embedded tree, and the file set must be the pinned one: the assertion below
	// is against the pinned checkout's digests, so a built-in whose files are
	// missing from upstream/ fails HERE and is reported as its own finding rather
	// than assumed away.
	total := 0
	missing := make([]string, 0)
	for _, extension := range fixture.SystemExtensions {
		root := path.Join("public", "scripts", "extensions", extension.Name)
		for _, file := range extension.Files {
			total++
			embedded, err := upstream.Assets.ReadFile(path.Join(root, file.Path))
			if err != nil {
				missing = append(missing, path.Join(root, file.Path))
				continue
			}
			if got := extensionsDiscoverySha256(embedded); got != file.Sha256 {
				t.Fatalf("embedded %s hashes to %s; the pinned checkout has %s", path.Join(root, file.Path), got, file.Sha256)
			}
		}
	}
	if len(missing) > 0 {
		t.Fatalf("%d file(s) of the built-in extensions discovery lists are missing from the embedded tree: %s", len(missing), strings.Join(missing, ", "))
	}
	if total != fixture.Extra.SystemFileCount {
		t.Fatalf("the fixture records %d built-in files but the test walked %d", fixture.Extra.SystemFileCount, total)
	}
	t.Logf("embedded built-in coverage: %d built-in extensions, %d files, %d static observations", len(fixture.SystemExtensions), total, len(observed))

	// The pinned frontend's first request for a built-in extension happens before
	// any session exists in a multi-user install, because express.static is
	// mounted ahead of the login middleware (server-main.js:242 vs :248).
	first := fixture.SystemExtensions[0].Name
	anonymous := install.serve(http.MethodGet, "/scripts/extensions/"+first+"/manifest.json", "", "", "", nil)
	if anonymous.Code != fixture.Extra.AnonymousManifestStatus {
		t.Fatalf("unauthenticated GET /scripts/extensions/%s/manifest.json = %d; pinned Node answers %d", first, anonymous.Code, fixture.Extra.AnonymousManifestStatus)
	}
}

func extensionsDiscoverySha256(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func extensionsDiscoverySortedCopy(values []string) []string {
	result := make([]string, len(values))
	copy(result, values)
	sort.Strings(result)
	return result
}

// TestPinnedEmbeddedExtensionTreeShape records the PREMISE behind a mutation
// survivor. Making the embedded manifest.json filter a no-op changes nothing,
// because the only embedded directory without a manifest.json is the
// third-party container, which the pinned name exclusion removes first
// (extensions.js:509 runs before the manifest filter at :510). The two
// predicates are therefore indistinguishable on this tree, so the embedded copy
// of the filter cannot be killed from the embedded side; the DISK copy of the
// same predicate is killed by TestPinnedExtensionDiscoverDiskWins.
//
// This test keeps that premise honest rather than silent. It also cross-checks
// the recorded pinned list against the embedded tree: the system names the
// pinned server reported must be exactly the embedded directories that carry a
// manifest, which is what makes "every built-in the list names has files behind
// it" true by construction. If upstream ever embeds an extension folder without
// a manifest, discovery's embedded projection would start depending on the
// filter, so this fails and the filter becomes testable.
func TestPinnedEmbeddedExtensionTreeShape(t *testing.T) {
	fixture := loadExtensionsDiscoveryFixture(t)
	root := embeddedPinnedExtensionsRoot()
	entries, err := fs.ReadDir(upstream.Assets, root)
	if err != nil {
		t.Fatal(err)
	}
	withManifest := make([]string, 0, len(entries))
	withoutManifest := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := fs.Stat(upstream.Assets, path.Join(root, entry.Name(), "manifest.json")); err == nil {
			withManifest = append(withManifest, entry.Name())
			continue
		}
		withoutManifest = append(withoutManifest, entry.Name())
	}
	if len(withManifest) == 0 {
		t.Fatal("no embedded extension directory carries a manifest.json, so the premise this test records cannot be checked")
	}
	if !reflect.DeepEqual(withoutManifest, []string{"third-party"}) {
		t.Fatalf("embedded extension directories WITHOUT manifest.json = %v; the premise that makes the embedded manifest filter unobservable is that this is exactly [third-party]", withoutManifest)
	}
	recorded := make([]string, 0, len(fixture.SystemExtensions))
	for _, extension := range fixture.SystemExtensions {
		recorded = append(recorded, extension.Name)
	}
	sort.Strings(recorded)
	if !reflect.DeepEqual(recorded, withManifest) {
		t.Fatalf("the pinned system list %v is not the embedded directories carrying a manifest %v", recorded, withManifest)
	}
	t.Logf("embedded system extensions: %d directories carry a manifest, %d do not (%s)", len(withManifest), len(withoutManifest), strings.Join(withoutManifest, ", "))
}
