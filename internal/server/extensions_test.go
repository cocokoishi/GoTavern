package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// Pinned extension-route oracle comparison. Every git observation is made
// against repositories this test builds with the same fixed identities and
// dates the probe used, and the test refuses to run when the local git produces
// different commit hashes than the fixture: a passing comparison against
// different objects would prove nothing.

type extensionsFixtureResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    any               `json:"body"`
}

type extensionsTreeEntry struct {
	Path    string  `json:"path"`
	Kind    string  `json:"kind"`
	Content *string `json:"content"`
}

type extensionsFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Normalizations []string `json:"normalizations"`
	Inputs         struct {
		CookieSecret        string                    `json:"cookieSecret"`
		SeededUsers         []map[string]any          `json:"seededUsers"`
		BuiltInExtensions   []extensionsBuiltInEntry  `json:"builtInExtensions"`
		LocalExtensions     map[string]any            `json:"localExtensions"`
		GlobalExtensions    map[string]any            `json:"globalExtensions"`
		PlainUserExtensions map[string]any            `json:"plainUserExtensions"`
		Git                 extensionsFixtureGitInput `json:"git"`
	} `json:"inputs"`
	Responses  map[string]extensionsFixtureResponse `json:"responses"`
	ErrorPages map[string]struct {
		Status int `json:"status"`
	} `json:"errorPages"`
	Extra struct {
		UserExtensionsDirectoryRecreated bool   `json:"userExtensionsDirectoryRecreated"`
		SwitchToRemoteBranchFile         string `json:"switchToRemoteBranchFile"`
		SwitchToRemoteBranchBranch       string `json:"switchToRemoteBranchBranch"`
		SwitchBackToMainFile             string `json:"switchBackToMainFile"`
		UpdatePulledCommit               string `json:"updatePulledCommit"`
		UpdatePulledFile                 string `json:"updatePulledFile"`
	} `json:"extra"`
	State struct {
		UserAfterMove           []extensionsTreeEntry `json:"userAfterMove"`
		GlobalAfterMove         []extensionsTreeEntry `json:"globalAfterMove"`
		UserAfterDelete         []extensionsTreeEntry `json:"userAfterDelete"`
		GlobalAfterDelete       []extensionsTreeEntry `json:"globalAfterDelete"`
		UserAfterInstall        []extensionsTreeEntry `json:"userAfterInstall"`
		GlobalAfterInstall      []extensionsTreeEntry `json:"globalAfterInstall"`
		InstalledTree           []extensionsTreeEntry `json:"installedTree"`
		InstalledGlobalTree     []extensionsTreeEntry `json:"installedGlobalTree"`
		InstalledGlobalRepoTree []extensionsTreeEntry `json:"installedGlobalRepoTree"`
	} `json:"state"`
	Disabled map[string]extensionsFixtureResponse `json:"disabled"`
}

type extensionsBuiltInEntry struct {
	Name        string `json:"name"`
	HasManifest bool   `json:"hasManifest"`
}

type extensionsFixtureGitInput struct {
	FullCommitHashes   map[string]string `json:"fullCommitHashes"`
	OriginBranch       string            `json:"originBranch"`
	FeatureBranch      string            `json:"featureBranch"`
	AltBranch          string            `json:"altBranch"`
	CommitMessages     map[string]string `json:"commitMessages"`
	OriginRemoteSuffix string            `json:"originRemoteSuffix"`
	InstallRepos       map[string]string `json:"installRepos"`
	InstallManifests   map[string]string `json:"installManifests"`
}

// extensionsNormalizer mirrors the probe's recorded normalization exactly.
type extensionsNormalizer struct {
	replacements [][2]string
	portPattern  *regexp.Regexp
}

func newExtensionsNormalizer(runtimeRoot, installRoot string) extensionsNormalizer {
	return extensionsNormalizer{
		replacements: [][2]string{
			{runtimeRoot, "<runtime>"},
			{installRoot, "<install>"},
		},
		portPattern: regexp.MustCompile(`http://127\.0\.0\.1:\d+`),
	}
}

func (normalizer extensionsNormalizer) text(value string) string {
	result := value
	for _, replacement := range normalizer.replacements {
		result = strings.ReplaceAll(result, replacement[0], replacement[1])
		result = strings.ReplaceAll(result, strings.ReplaceAll(replacement[0], `\`, "/"), replacement[1])
	}
	result = normalizer.portPattern.ReplaceAllString(result, "http://127.0.0.1:<port>")
	return strings.ReplaceAll(result, `\`, "/")
}

func (normalizer extensionsNormalizer) value(value any) any {
	switch typed := value.(type) {
	case string:
		return normalizer.text(typed)
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = normalizer.value(item)
		}
		return result
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			result[key] = normalizer.value(item)
		}
		return result
	default:
		return value
	}
}

// containsExtensionsPathObservation mirrors the probe's decision to record
// content-length and ETag as markers. It is evaluated on the normalized body,
// so the decision is identical on every host even though Express derived those
// headers from this host's raw bytes.
func containsExtensionsPathObservation(value any) bool {
	switch typed := value.(type) {
	case string:
		return strings.Contains(typed, "/") || strings.Contains(typed, "<runtime>") ||
			strings.Contains(typed, "<install>") || strings.Contains(typed, "<port>")
	case []any:
		for _, item := range typed {
			if containsExtensionsPathObservation(item) {
				return true
			}
		}
	case map[string]any:
		for _, item := range typed {
			if containsExtensionsPathObservation(item) {
				return true
			}
		}
	}
	return false
}

// snapshotExtensionsTree mirrors the probe's tree snapshot: sorted relative
// paths, kind and exact bytes, never sizes or mtimes, and a .git directory
// recorded as a single marker because its internals belong to the git build.
func snapshotExtensionsTree(t *testing.T, root string) []extensionsTreeEntry {
	t.Helper()
	if _, err := os.Stat(root); err != nil {
		return nil
	}
	entries := make([]extensionsTreeEntry, 0)
	var walk func(directory, prefix string)
	walk = func(directory, prefix string) {
		children, err := os.ReadDir(directory)
		if err != nil {
			t.Fatal(err)
		}
		names := make([]string, 0, len(children))
		for _, child := range children {
			names = append(names, child.Name())
		}
		sort.Strings(names)
		for _, name := range names {
			absolute := filepath.Join(directory, name)
			relative := name
			if prefix != "" {
				relative = prefix + "/" + name
			}
			info, err := os.Lstat(absolute)
			if err != nil {
				t.Fatal(err)
			}
			switch {
			case name == ".git":
				// A .git directory holds build-specific internals and a .git file
				// holds an absolute gitdir pointer; both are one marker.
				entries = append(entries, extensionsTreeEntry{Path: relative, Kind: "git-directory"})
			case info.Mode()&os.ModeSymlink != 0:
				entries = append(entries, extensionsTreeEntry{Path: relative, Kind: "other"})
			case info.IsDir():
				entries = append(entries, extensionsTreeEntry{Path: relative, Kind: "directory"})
				walk(absolute, relative)
			case info.Mode().IsRegular():
				body, err := os.ReadFile(absolute)
				if err != nil {
					t.Fatal(err)
				}
				content := string(body)
				entries = append(entries, extensionsTreeEntry{Path: relative, Kind: "file", Content: &content})
			default:
				entries = append(entries, extensionsTreeEntry{Path: relative, Kind: "other"})
			}
		}
	}
	walk(root, "")
	sort.SliceStable(entries, func(left, right int) bool { return entries[left].Path < entries[right].Path })
	return entries
}

// extensionsGitEnvironment returns the process environment with the pinned
// identity/config overrides applied, removing any inherited duplicates so a
// developer machine's git config cannot leak into the fixture repositories.
func extensionsGitEnvironment(overrides map[string]string) []string {
	blocked := make(map[string]bool, len(overrides))
	for key := range overrides {
		blocked[strings.ToUpper(key)] = true
	}
	environment := make([]string, 0, len(os.Environ())+len(overrides))
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index > 0 && blocked[strings.ToUpper(entry[:index])] {
			continue
		}
		environment = append(environment, entry)
	}
	for key, value := range overrides {
		environment = append(environment, key+"="+value)
	}
	return environment
}

func runExtensionsGit(t *testing.T, directory string, overrides map[string]string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, args...)...)
	command.Env = extensionsGitEnvironment(overrides)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String())
}

func writeExtensionsFile(t *testing.T, target, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func seedExtensionsDirectory(t *testing.T, directory string, entries map[string]any) {
	t.Helper()
	for name, value := range entries {
		switch typed := value.(type) {
		case string:
			writeExtensionsFile(t, filepath.Join(directory, name), typed)
		case map[string]any:
			for relative, content := range typed {
				text, isString := content.(string)
				if !isString {
					t.Fatalf("extension seed %s/%s is not a string", name, relative)
				}
				writeExtensionsFile(t, filepath.Join(directory, name, relative), text)
			}
		default:
			t.Fatalf("extension seed %s has unexpected shape %T", name, value)
		}
	}
}

func initExtensionsTestRepo(t *testing.T, directory string) {
	t.Helper()
	if err := os.MkdirAll(directory, 0o777); err != nil {
		t.Fatal(err)
	}
	runExtensionsGit(t, directory, nil, "init")
	runExtensionsGit(t, directory, nil, "symbolic-ref", "HEAD", "refs/heads/main")
}

func commitExtensionsTestRepo(t *testing.T, directory, message, date string) string {
	t.Helper()
	overrides := map[string]string{"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date}
	runExtensionsGit(t, directory, nil, "add", ".")
	runExtensionsGit(t, directory, overrides, "commit", "-m", message)
	return runExtensionsGit(t, directory, nil, "rev-parse", "HEAD")
}

// buildExtensionsBareRepo mirrors the probe's makeBareRepo: a main commit and an
// optional second branch, cloned bare into <name>.git.
func buildExtensionsBareRepo(t *testing.T, gitRoot, name string, files map[string]string, branchName string, branchFiles map[string]string, dateOne, dateTwo string) (string, string, string) {
	t.Helper()
	work := filepath.Join(gitRoot, "work-"+name)
	initExtensionsTestRepo(t, work)
	for relative, content := range files {
		writeExtensionsFile(t, filepath.Join(work, relative), content)
	}
	mainCommit := commitExtensionsTestRepo(t, work, "main commit", dateOne)
	branchCommit := ""
	if branchName != "" {
		runExtensionsGit(t, work, nil, "checkout", "-b", branchName)
		for relative, content := range branchFiles {
			writeExtensionsFile(t, filepath.Join(work, relative), content)
		}
		branchCommit = commitExtensionsTestRepo(t, work, "branch commit", dateTwo)
		runExtensionsGit(t, work, nil, "checkout", "main")
	}
	bare := filepath.Join(gitRoot, name+".git")
	runExtensionsGit(t, gitRoot, nil, "clone", "--bare", work, bare)
	runExtensionsGit(t, bare, nil, "symbolic-ref", "HEAD", "refs/heads/main")
	return bare, mainCommit, branchCommit
}

func extensionsFileURL(target string) string {
	slashed := filepath.ToSlash(target)
	if !strings.HasPrefix(slashed, "/") {
		slashed = "/" + slashed
	}
	return (&url.URL{Scheme: "file", Path: slashed}).String()
}

func TestPinnedNodeExtensionRoutes(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-extensions-routes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture extensionsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("extensions oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Responses) == 0 || len(fixture.Disabled) == 0 || len(fixture.Normalizations) == 0 {
		t.Fatal("extensions oracle is missing observations or normalizations")
	}
	// The pinned routes drive git; without a git binary the whole domain is a
	// documented gap and this comparison cannot be made. Fail loudly instead of
	// skipping, because a silent skip would read as coverage.
	if _, err := exec.LookPath("git"); err != nil {
		t.Fatalf("the pinned extension routes require a git binary in PATH: %v", err)
	}

	runtimeRoot := t.TempDir()
	dataRoot := filepath.Join(runtimeRoot, "data")
	installRoot := filepath.Join(runtimeRoot, "install")
	gitRoot := filepath.Join(runtimeRoot, "git")
	if err := os.MkdirAll(gitRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	emptyGitConfig := filepath.Join(runtimeRoot, "empty-gitconfig")
	if err := os.WriteFile(emptyGitConfig, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	// The handler runs in this process, so its git commands inherit these.
	for key, value := range map[string]string{
		"GIT_CONFIG_GLOBAL":   emptyGitConfig,
		"GIT_CONFIG_SYSTEM":   emptyGitConfig,
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_TERMINAL_PROMPT": "0",
		"GIT_AUTHOR_NAME":     "GoTavern Probe",
		"GIT_AUTHOR_EMAIL":    "probe@gotavern.invalid",
		"GIT_COMMITTER_NAME":  "GoTavern Probe",
		"GIT_COMMITTER_EMAIL": "probe@gotavern.invalid",
	} {
		t.Setenv(key, value)
	}

	const dateOne = "2020-01-01T00:00:00+00:00"
	const dateTwo = "2020-01-02T00:00:00+00:00"
	const dateThree = "2020-01-03T00:00:00+00:00"

	// ---- fixture repositories --------------------------------------------
	originWork := filepath.Join(gitRoot, "work-origin")
	initExtensionsTestRepo(t, originWork)
	writeExtensionsFile(t, filepath.Join(originWork, "probe.txt"), "one\n")
	firstCommit := commitExtensionsTestRepo(t, originWork, fixture.Inputs.Git.CommitMessages["first"], dateOne)
	writeExtensionsFile(t, filepath.Join(originWork, "probe.txt"), "two\n")
	secondCommit := commitExtensionsTestRepo(t, originWork, fixture.Inputs.Git.CommitMessages["second"], dateTwo)
	runExtensionsGit(t, originWork, nil, "branch", fixture.Inputs.Git.FeatureBranch, firstCommit)
	originBare := filepath.Join(gitRoot, "origin.git")
	runExtensionsGit(t, gitRoot, nil, "clone", "--bare", originWork, originBare)
	runExtensionsGit(t, originBare, nil, "symbolic-ref", "HEAD", "refs/heads/main")

	_, manifestMain, manifestAlt := buildExtensionsBareRepo(t, gitRoot, "manifest",
		map[string]string{"manifest.json": fixture.Inputs.Git.InstallManifests["main"], "probe.txt": "main\n"},
		fixture.Inputs.Git.AltBranch,
		map[string]string{"manifest.json": fixture.Inputs.Git.InstallManifests["alt"], "probe.txt": "alt\n"},
		dateOne, dateTwo)
	buildExtensionsBareRepo(t, gitRoot, "partial", map[string]string{"manifest.json": `{"display_name":"Partial Extension"}`}, "", nil, dateOne, dateTwo)
	buildExtensionsBareRepo(t, gitRoot, "nofields", map[string]string{"manifest.json": `{}`}, "", nil, dateOne, dateTwo)
	buildExtensionsBareRepo(t, gitRoot, "nomanifest", map[string]string{"probe.txt": "no manifest\n"}, "", nil, dateOne, dateTwo)
	buildExtensionsBareRepo(t, gitRoot, "badmanifest", map[string]string{"manifest.json": "not json at all"}, "", nil, dateOne, dateTwo)
	buildExtensionsBareRepo(t, gitRoot, "arraymanifest", map[string]string{"manifest.json": "[1,2,3]"}, "", nil, dateOne, dateTwo)
	buildExtensionsBareRepo(t, gitRoot, "nullmanifest", map[string]string{"manifest.json": "null"}, "", nil, dateOne, dateTwo)
	buildExtensionsBareRepo(t, gitRoot, "global", map[string]string{"manifest.json": `{"display_name":"Global Extension","version":"2.0.0","author":"Global Author"}`}, "", nil, dateOne, dateTwo)

	observedHashes := map[string]string{
		"originFirst":  firstCommit,
		"originSecond": secondCommit,
		"manifestMain": manifestMain,
		"manifestAlt":  manifestAlt,
	}
	for label, want := range fixture.Inputs.Git.FullCommitHashes {
		if label == "originThird" {
			continue
		}
		got, exists := observedHashes[label]
		if !exists {
			t.Fatalf("fixture records commit %q which this test does not build", label)
		}
		if got != want {
			t.Fatalf("git produced %s for %s but the oracle recorded %s; this host's git cannot reproduce the pinned fixture, so the comparison is refused rather than passed vacuously", got, label, want)
		}
	}

	// ---- smart HTTP git server -------------------------------------------
	gitExecutable, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	gitServer := httptest.NewServer(&cgi.Handler{
		Path: gitExecutable,
		Args: []string{"http-backend"},
		Env: []string{
			"GIT_PROJECT_ROOT=" + gitRoot,
			"GIT_HTTP_EXPORT_ALL=1",
			"GIT_HTTP_MAX_REQUEST_BUFFER=100M",
		},
		InheritEnv: []string{
			"PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE",
			"GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM",
			"GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
			"GIT_TERMINAL_PROMPT",
		},
		Stderr: io.Discard,
	})
	defer gitServer.Close()
	gitOriginBase := gitServer.URL

	// ---- data root, install root and users --------------------------------
	if err := os.MkdirAll(filepath.Join(dataRoot, "_storage"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, user := range fixture.Inputs.SeededUsers {
		handle, _ := user["handle"].(string)
		encoded, err := marshalNodeJSON(user)
		if err != nil {
			t.Fatal(err)
		}
		if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+handle, encoded); err != nil {
			t.Fatal(err)
		}
	}
	handles := make([]string, 0, len(fixture.Inputs.SeededUsers))
	for _, user := range fixture.Inputs.SeededUsers {
		handle, _ := user["handle"].(string)
		handles = append(handles, handle)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, handles); err != nil {
		t.Fatal(err)
	}

	builtInRoot := filepath.Join(installRoot, "public", "scripts", "extensions")
	globalRoot := filepath.Join(builtInRoot, "third-party")
	if err := os.MkdirAll(globalRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	for _, builtIn := range fixture.Inputs.BuiltInExtensions {
		if builtIn.HasManifest {
			writeExtensionsFile(t, filepath.Join(builtInRoot, builtIn.Name, "manifest.json"), "{}")
			continue
		}
		if err := os.MkdirAll(filepath.Join(builtInRoot, builtIn.Name), 0o777); err != nil {
			t.Fatal(err)
		}
	}
	// The pinned checkout keeps this placeholder inside the global directory.
	writeExtensionsFile(t, filepath.Join(globalRoot, ".gitkeep"), "")

	defaultDirectories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	plainDirectories, err := startup.DirectoriesForUser(dataRoot, "plainuser")
	if err != nil {
		t.Fatal(err)
	}
	userExtensionsRoot := defaultDirectories["extensions"]
	plainExtensionsRoot := plainDirectories["extensions"]
	for _, root := range []string{userExtensionsRoot, plainExtensionsRoot} {
		if err := os.RemoveAll(root); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(root, 0o777); err != nil {
			t.Fatal(err)
		}
	}
	seedExtensionsDirectory(t, userExtensionsRoot, fixture.Inputs.LocalExtensions)
	seedExtensionsDirectory(t, plainExtensionsRoot, fixture.Inputs.PlainUserExtensions)
	seedExtensionsDirectory(t, globalRoot, fixture.Inputs.GlobalExtensions)

	// The working clone lives inside the user's extension directory. A file://
	// URL is required because git ignores --depth for a plain local path.
	probeGitDirectory := filepath.Join(userExtensionsRoot, "probe-git")
	runExtensionsGit(t, gitRoot, nil, "clone", "--depth", "1", extensionsFileURL(originBare), probeGitDirectory)
	if head := runExtensionsGit(t, probeGitDirectory, nil, "rev-parse", "HEAD"); head != secondCommit {
		t.Fatalf("probe clone HEAD %s != %s", head, secondCommit)
	}
	if shallow := runExtensionsGit(t, probeGitDirectory, nil, "rev-parse", "--is-shallow-repository"); shallow != "true" {
		t.Fatalf("probe clone is not shallow (%q), so the pinned /branches unshallow path would not be exercised", shallow)
	}
	// A directory whose .git is a file pointing at another repository's gitdir is
	// a valid work tree but not a repository root, so the pinned checkIsRepoRoot
	// is false while rev-parse HEAD still succeeds.
	runExtensionsGit(t, originWork, nil, "remote", "add", "origin", originBare)
	nestedExtension := filepath.Join(userExtensionsRoot, "probe-nested")
	if err := os.MkdirAll(nestedExtension, 0o777); err != nil {
		t.Fatal(err)
	}
	writeExtensionsFile(t, filepath.Join(nestedExtension, ".git"), "gitdir: "+filepath.Join(originWork, ".git")+"\n")

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
	cookieFrom := func(cookies []string) string {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	login := func(handle string) (string, string) {
		t.Helper()
		csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", "", nil)
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
		body, _ := json.Marshal(map[string]string{"handle": handle, "password": ""})
		response := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, "application/json", body)
		if response.Code != http.StatusOK {
			t.Fatalf("POST /api/users/login as %s = %d, body %q", handle, response.Code, response.Body.String())
		}
		return csrf.Token, cookieFrom(response.Header().Values("Set-Cookie"))
	}
	adminToken, adminCookie := login("default-user")
	plainToken, plainCookie := login("plainuser")

	normalizer := newExtensionsNormalizer(runtimeRoot, installRoot)

	skipHeaders := map[string]bool{
		"connection": true, "date": true, "keep-alive": true, "last-modified": true,
		"set-cookie": true, "x-response-time": true,
	}
	capture := func(recorder *httptest.ResponseRecorder, discovery bool) extensionsFixtureResponse {
		t.Helper()
		rawBody := recorder.Body.Bytes()
		var parsed any
		if len(rawBody) > 0 {
			if err := json.Unmarshal(rawBody, &parsed); err != nil {
				parsed = string(rawBody)
			}
		}
		headers := make(map[string]string)
		for name, values := range recorder.Result().Header {
			lower := strings.ToLower(name)
			if skipHeaders[lower] {
				continue
			}
			headers[lower] = strings.Join(values, ", ")
		}
		body := parsed
		if discovery {
			body = normalizeDiscoveryFixture(parsed)
		}
		normalizedBody := normalizer.value(body)
		if containsExtensionsPathObservation(normalizedBody) {
			if _, exists := headers["content-length"]; exists {
				headers["content-length"] = "<path-body-length>"
			}
			if _, exists := headers["etag"]; exists {
				headers["etag"] = "<path-body-etag>"
			}
		}
		return extensionsFixtureResponse{Status: recorder.Code, Headers: headers, Body: normalizedBody}
	}

	post := func(route, token, cookie, body string) *httptest.ResponseRecorder {
		t.Helper()
		return serve(http.MethodPost, "/api/extensions/"+route, cookie, token, "application/json", []byte(body))
	}
	adminPost := func(route, body string) *httptest.ResponseRecorder { return post(route, adminToken, adminCookie, body) }
	plainPost := func(route, body string) *httptest.ResponseRecorder { return post(route, plainToken, plainCookie, body) }

	responses := map[string]extensionsFixtureResponse{}
	errorPages := map[string]int{}
	extra := map[string]any{}
	record := func(label string, recorder *httptest.ResponseRecorder) {
		t.Helper()
		responses[label] = capture(recorder, false)
	}
	recordDiscovery := func(label string, recorder *httptest.ResponseRecorder) {
		t.Helper()
		responses[label] = capture(recorder, true)
	}
	recordErrorPage := func(label string, recorder *httptest.ResponseRecorder) {
		t.Helper()
		errorPages[label] = recorder.Code
	}

	// ---- /discover --------------------------------------------------------
	recordDiscovery("discoverAdmin", serve(http.MethodGet, "/api/extensions/discover", adminCookie, "", "", nil))
	recordDiscovery("discoverPlain", serve(http.MethodGet, "/api/extensions/discover", plainCookie, "", "", nil))
	record("discoverWrongMethod", adminPost("discover", `{}`))
	if err := os.RemoveAll(plainExtensionsRoot); err != nil {
		t.Fatal(err)
	}
	recordDiscovery("discoverRecreatesUserDirectory", serve(http.MethodGet, "/api/extensions/discover", plainCookie, "", "", nil))
	info, err := os.Stat(plainExtensionsRoot)
	extra["userExtensionsDirectoryRecreated"] = err == nil && info.IsDir()
	seedExtensionsDirectory(t, plainExtensionsRoot, fixture.Inputs.PlainUserExtensions)

	// ---- /version ---------------------------------------------------------
	record("versionNonRepo", adminPost("version", `{"extensionName":"probe-local-one"}`))
	record("versionGit", adminPost("version", `{"extensionName":"probe-git"}`))
	record("versionMissing", adminPost("version", `{"extensionName":"probe-missing"}`))
	record("versionSanitizesToEmpty", adminPost("version", `{"extensionName":".."}`))
	record("versionNonString", adminPost("version", `{"extensionName":5}`))
	record("versionNoName", adminPost("version", `{}`))
	record("versionGlobalNonAdmin", plainPost("version", `{"extensionName":"probe-global-one","global":true}`))
	record("versionNestedRepo", adminPost("version", `{"extensionName":"probe-nested"}`))
	record("updateNestedRepo", adminPost("update", `{"extensionName":"probe-nested"}`))
	record("versionWrongMethod", serve(http.MethodGet, "/api/extensions/version", adminCookie, "", "", nil))
	recordErrorPage("versionMalformedBody", adminPost("version", `{`))

	// ---- /branches --------------------------------------------------------
	record("branchesGit", adminPost("branches", `{"extensionName":"probe-git"}`))
	record("branchesNonGit", adminPost("branches", `{"extensionName":"probe-local-one"}`))
	record("branchesMissing", adminPost("branches", `{"extensionName":"probe-missing"}`))
	record("branchesNonString", adminPost("branches", `{"extensionName":5}`))
	record("branchesGlobalNonAdmin", plainPost("branches", `{"extensionName":"probe-global-one","global":true}`))

	// ---- /switch ----------------------------------------------------------
	record("switchMissing", adminPost("switch", `{"extensionName":"probe-missing","branch":"main"}`))
	record("switchNoBranch", adminPost("switch", `{"extensionName":"probe-git"}`))
	record("switchNonStringBranch", adminPost("switch", `{"extensionName":"probe-git","branch":5}`))
	record("switchUnknownLocal", adminPost("switch", `{"extensionName":"probe-git","branch":"nope"}`))
	record("switchToRemoteBranch", adminPost("switch", `{"extensionName":"probe-git","branch":"origin/feature-b"}`))
	if body, err := os.ReadFile(filepath.Join(probeGitDirectory, "probe.txt")); err == nil {
		extra["switchToRemoteBranchFile"] = string(body)
	}
	extra["switchToRemoteBranchBranch"] = runExtensionsGit(t, probeGitDirectory, nil, "rev-parse", "--abbrev-ref", "HEAD")
	record("switchAlreadyCheckedOut", adminPost("switch", `{"extensionName":"probe-git","branch":"feature-b"}`))
	record("switchBackToMain", adminPost("switch", `{"extensionName":"probe-git","branch":"main"}`))
	if body, err := os.ReadFile(filepath.Join(probeGitDirectory, "probe.txt")); err == nil {
		extra["switchBackToMainFile"] = string(body)
	}
	record("switchGlobalNonAdmin", plainPost("switch", `{"extensionName":"probe-global-one","branch":"main","global":true}`))

	// ---- /update ----------------------------------------------------------
	writeExtensionsFile(t, filepath.Join(originWork, "probe.txt"), "three\n")
	thirdCommit := commitExtensionsTestRepo(t, originWork, fixture.Inputs.Git.CommitMessages["third"], dateThree)
	runExtensionsGit(t, originWork, nil, "push", originBare, "main")
	if want, exists := fixture.Inputs.Git.FullCommitHashes["originThird"]; !exists || thirdCommit != want {
		t.Fatalf("third commit %s does not match the oracle's %s", thirdCommit, want)
	}
	record("updateGit", adminPost("update", `{"extensionName":"probe-git"}`))
	extra["updatePulledCommit"] = runExtensionsGit(t, probeGitDirectory, nil, "rev-parse", "HEAD")
	if body, err := os.ReadFile(filepath.Join(probeGitDirectory, "probe.txt")); err == nil {
		extra["updatePulledFile"] = string(body)
	}
	record("updateAgain", adminPost("update", `{"extensionName":"probe-git"}`))
	record("versionAfterUpdate", adminPost("version", `{"extensionName":"probe-git"}`))
	record("updateNonGit", adminPost("update", `{"extensionName":"probe-local-one"}`))
	record("updateMissing", adminPost("update", `{"extensionName":"probe-missing"}`))
	record("updateNonString", adminPost("update", `{"extensionName":5}`))
	record("updateGlobalNonAdmin", plainPost("update", `{"extensionName":"probe-global-one","global":true}`))

	// ---- /move ------------------------------------------------------------
	record("moveUserToGlobal", adminPost("move", `{"extensionName":"probe-local-one","source":"user","destination":"global"}`))
	record("moveGlobalToUser", adminPost("move", `{"extensionName":"probe-global-one","source":"global","destination":"user"}`))
	record("moveSameGlobalSource", adminPost("move", `{"extensionName":"probe-global-conflict","source":"global","destination":"global"}`))
	record("moveSourceMissing", adminPost("move", `{"extensionName":"probe-missing","source":"user","destination":"global"}`))
	record("moveDestinationExists", adminPost("move", `{"extensionName":"probe-global-conflict","source":"user","destination":"global"}`))
	record("moveSourceIsFile", adminPost("move", `{"extensionName":"probe-local-file.txt","source":"user","destination":"global"}`))
	record("moveMissingDestination", adminPost("move", `{"extensionName":"probe-global-conflict","source":"user"}`))
	record("moveNonString", adminPost("move", `{"extensionName":5,"source":"user","destination":"global"}`))
	record("moveSanitizesToEmpty", adminPost("move", `{"extensionName":"..","source":"user","destination":"global"}`))
	record("moveNonAdmin", plainPost("move", `{"extensionName":"probe-global-conflict","source":"user","destination":"global"}`))
	record("moveGlobalSourceNonAdmin", plainPost("move", `{"extensionName":"probe-global-conflict","source":"global","destination":"user"}`))
	record("moveWrongMethod", serve(http.MethodGet, "/api/extensions/move", adminCookie, "", "", nil))
	userAfterMove := snapshotExtensionsTree(t, userExtensionsRoot)
	globalAfterMove := snapshotExtensionsTree(t, globalRoot)

	// ---- /delete ----------------------------------------------------------
	record("deleteUserExtension", adminPost("delete", `{"extensionName":"probe-local-nomanifest"}`))
	record("deleteGlobalExtension", adminPost("delete", `{"extensionName":"probe-local-one","global":true}`))
	record("deleteMissing", adminPost("delete", `{"extensionName":"probe-missing"}`))
	record("deleteNonString", adminPost("delete", `{"extensionName":5}`))
	record("deleteSanitizesToEmpty", adminPost("delete", `{"extensionName":".."}`))
	record("deleteGlobalNonAdmin", plainPost("delete", `{"extensionName":"probe-global-conflict","global":true}`))
	record("deleteWrongMethod", serve(http.MethodGet, "/api/extensions/delete", adminCookie, "", "", nil))
	userAfterDelete := snapshotExtensionsTree(t, userExtensionsRoot)
	globalAfterDelete := snapshotExtensionsTree(t, globalRoot)

	// ---- /install ---------------------------------------------------------
	record("installValid", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/manifest.git")))
	installedTree := snapshotExtensionsTree(t, filepath.Join(userExtensionsRoot, "manifest"))
	record("installBranchGlobal", adminPost("install", fmt.Sprintf(`{"url":%q,"branch":"alt","global":true}`, gitOriginBase+"/manifest.git")))
	installedGlobalTree := snapshotExtensionsTree(t, filepath.Join(globalRoot, "manifest"))
	record("installPartialManifest", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/partial.git")))
	record("installNoFields", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/nofields.git")))
	record("installExistingDirectory", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/manifest.git")))
	record("installEncodedNameNotDecoded", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/My%20Repo.git")))
	record("installSpaceNameEncoded", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/My Repo.git")))
	record("installNoManifest", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/nomanifest.git")))
	record("installBadManifest", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/badmanifest.git")))
	record("installArrayManifest", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/arraymanifest.git")))
	record("installNullManifest", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/nullmanifest.git")))
	record("installCloneFailure", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/does-not-exist.git")))
	record("installInvalidURL", adminPost("install", `{"url":"not a url"}`))
	record("installRelativeURL", adminPost("install", `{"url":"/foo.git"}`))
	record("installFileProtocol", adminPost("install", `{"url":"file:///tmp/probe.git"}`))
	record("installMailtoProtocol", adminPost("install", `{"url":"mailto:probe@gotavern.invalid"}`))
	record("installMissingURL", adminPost("install", `{}`))
	record("installNonStringURL", adminPost("install", `{"url":5}`))
	record("installEmptyNameURL", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/")))
	record("installDotGitURL", adminPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/.git")))
	record("installWrongMethod", serve(http.MethodGet, "/api/extensions/install", adminCookie, "", "", nil))
	record("installGlobalNonAdminInvalidURL", plainPost("install", `{"url":"not a url","global":true}`))
	record("installGlobalNonAdmin", plainPost("install", fmt.Sprintf(`{"url":%q,"global":true}`, gitOriginBase+"/global.git")))
	record("installGlobalAdmin", adminPost("install", fmt.Sprintf(`{"url":%q,"global":true}`, gitOriginBase+"/global.git")))
	installedGlobalRepoTree := snapshotExtensionsTree(t, filepath.Join(globalRoot, "global"))
	userAfterInstall := snapshotExtensionsTree(t, userExtensionsRoot)
	globalAfterInstall := snapshotExtensionsTree(t, globalRoot)

	// ---- extensions.enabled = false --------------------------------------
	disabled := map[string]extensionsFixtureResponse{}
	disabledHandler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true, ExtensionsEnabled: boolPointer(false),
	})
	serveDisabled := func(method, route, cookie, token, contentType string, body []byte) *httptest.ResponseRecorder {
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
		disabledHandler.ServeHTTP(response, request)
		return response
	}
	disabledCSRF := serveDisabled(http.MethodGet, "/csrf-token", "", "", "", nil)
	var disabledToken struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(disabledCSRF.Body.Bytes(), &disabledToken); err != nil {
		t.Fatal(err)
	}
	disabledCookie := cookieFrom(disabledCSRF.Header().Values("Set-Cookie"))
	disabledLoginBody, _ := json.Marshal(map[string]string{"handle": "default-user", "password": ""})
	disabledLogin := serveDisabled(http.MethodPost, "/api/users/login", disabledCookie, disabledToken.Token, "application/json", disabledLoginBody)
	if disabledLogin.Code != http.StatusOK {
		t.Fatalf("disabled-handler login = %d, body %q", disabledLogin.Code, disabledLogin.Body.String())
	}
	disabledSession := cookieFrom(disabledLogin.Header().Values("Set-Cookie"))
	disabledPost := func(route, body string) *httptest.ResponseRecorder {
		t.Helper()
		return serveDisabled(http.MethodPost, "/api/extensions/"+route, disabledSession, disabledToken.Token, "application/json", []byte(body))
	}
	disabled["install"] = capture(disabledPost("install", fmt.Sprintf(`{"url":%q}`, gitOriginBase+"/manifest.git")), false)
	disabled["update"] = capture(disabledPost("update", `{"extensionName":"probe-git"}`), false)
	disabled["branches"] = capture(disabledPost("branches", `{"extensionName":"probe-git"}`), false)
	disabled["switch"] = capture(disabledPost("switch", `{"extensionName":"probe-git","branch":"main"}`), false)
	disabled["move"] = capture(disabledPost("move", `{"extensionName":"probe-git","source":"user","destination":"global"}`), false)
	disabled["version"] = capture(disabledPost("version", `{"extensionName":"probe-git"}`), false)
	disabled["delete"] = capture(disabledPost("delete", `{"extensionName":"probe-git"}`), false)
	disabled["discover"] = capture(serveDisabled(http.MethodGet, "/api/extensions/discover", disabledSession, "", "", nil), false)
	disabled["unauthenticatedDiscover"] = capture(serveDisabled(http.MethodGet, "/api/extensions/discover", "", "", "", nil), false)

	// ---- comparisons ------------------------------------------------------
	// Every mismatch is reported, not just the first: one broken observation
	// must not hide the rest, and a map iteration order must not decide which
	// failure a reader sees.
	if len(responses) != len(fixture.Responses) {
		t.Errorf("the test recorded %d responses but the oracle has %d", len(responses), len(fixture.Responses))
	}
	for _, label := range sortedExtensionLabels(fixture.Responses) {
		got, recorded := responses[label]
		if !recorded {
			t.Errorf("the test did not record %q", label)
			continue
		}
		want := fixture.Responses[label]
		if got.Status != want.Status {
			t.Errorf("%s status = %d; pinned Node has %d (body %s)", label, got.Status, want.Status, formatAny(got.Body))
		}
		if !reflect.DeepEqual(got.Headers, want.Headers) {
			t.Errorf("%s headers = %s; pinned Node has %s", label, formatAny(got.Headers), formatAny(want.Headers))
		}
		if !reflect.DeepEqual(got.Body, want.Body) {
			t.Errorf("%s body = %s; pinned Node has %s", label, formatAny(got.Body), formatAny(want.Body))
		}
	}
	for _, label := range sortedExtensionErrorLabels(fixture.ErrorPages) {
		got, recorded := errorPages[label]
		if !recorded {
			t.Errorf("the test did not record error page %q", label)
			continue
		}
		if got != fixture.ErrorPages[label].Status {
			t.Errorf("%s status = %d; pinned Node has %d", label, got, fixture.ErrorPages[label].Status)
		}
	}
	for _, compare := range []struct {
		label string
		got   []extensionsTreeEntry
		want  []extensionsTreeEntry
	}{
		{"userAfterMove", userAfterMove, fixture.State.UserAfterMove},
		{"globalAfterMove", globalAfterMove, fixture.State.GlobalAfterMove},
		{"userAfterDelete", userAfterDelete, fixture.State.UserAfterDelete},
		{"globalAfterDelete", globalAfterDelete, fixture.State.GlobalAfterDelete},
		{"userAfterInstall", userAfterInstall, fixture.State.UserAfterInstall},
		{"globalAfterInstall", globalAfterInstall, fixture.State.GlobalAfterInstall},
		{"installedTree", installedTree, fixture.State.InstalledTree},
		{"installedGlobalTree", installedGlobalTree, fixture.State.InstalledGlobalTree},
		{"installedGlobalRepoTree", installedGlobalRepoTree, fixture.State.InstalledGlobalRepoTree},
	} {
		if !reflect.DeepEqual(compare.got, compare.want) {
			t.Errorf("extensions state %s = %s; pinned Node has %s", compare.label, formatAny(compare.got), formatAny(compare.want))
		}
	}
	for _, key := range []string{
		"userExtensionsDirectoryRecreated", "switchToRemoteBranchFile", "switchToRemoteBranchBranch",
		"switchBackToMainFile", "updatePulledCommit", "updatePulledFile",
	} {
		want := map[string]any{
			"userExtensionsDirectoryRecreated": fixture.Extra.UserExtensionsDirectoryRecreated,
			"switchToRemoteBranchFile":         fixture.Extra.SwitchToRemoteBranchFile,
			"switchToRemoteBranchBranch":       fixture.Extra.SwitchToRemoteBranchBranch,
			"switchBackToMainFile":             fixture.Extra.SwitchBackToMainFile,
			"updatePulledCommit":               fixture.Extra.UpdatePulledCommit,
			"updatePulledFile":                 fixture.Extra.UpdatePulledFile,
		}[key]
		if !reflect.DeepEqual(extra[key], want) {
			t.Errorf("extensions extra %s = %s; pinned Node has %s", key, formatAny(extra[key]), formatAny(want))
		}
	}
	if len(disabled) != len(fixture.Disabled) {
		t.Errorf("the test recorded %d disabled-extension responses but the oracle has %d", len(disabled), len(fixture.Disabled))
	}
	for _, label := range sortedExtensionLabels(fixture.Disabled) {
		got, recorded := disabled[label]
		if !recorded {
			t.Errorf("the test did not record disabled %q", label)
			continue
		}
		want := fixture.Disabled[label]
		if got.Status != want.Status {
			t.Errorf("disabled %s status = %d; pinned Node has %d", label, got.Status, want.Status)
		}
		if !reflect.DeepEqual(got.Headers, want.Headers) {
			t.Errorf("disabled %s headers = %s; pinned Node has %s", label, formatAny(got.Headers), formatAny(want.Headers))
		}
		if !reflect.DeepEqual(got.Body, want.Body) {
			t.Errorf("disabled %s body = %s; pinned Node has %s", label, formatAny(got.Body), formatAny(want.Body))
		}
	}
}

func sortedExtensionLabels(responses map[string]extensionsFixtureResponse) []string {
	labels := make([]string, 0, len(responses))
	for label := range responses {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	return labels
}

func sortedExtensionErrorLabels(pages map[string]struct {
	Status int `json:"status"`
}) []string {
	labels := make([]string, 0, len(pages))
	for label := range pages {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	return labels
}

func boolPointer(value bool) *bool { return &value }

func formatAny(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(encoded)
}

// normalizeDiscoveryFixture mirrors the probe's pinned-group ordering
// normalization for /discover, whose pinned order is fs.readdirSync order.
func normalizeDiscoveryFixture(value any) any {
	entries, isArray := value.([]any)
	if !isArray {
		return value
	}
	groupOrder := map[string]int{"system": 0, "local": 1, "global": 2}
	result := make([]any, 0, len(entries))
	for _, type_ := range []string{"system", "local", "global"} {
		group := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			object, isObject := entry.(map[string]any)
			if !isObject || object["type"] != type_ {
				continue
			}
			group = append(group, map[string]any{"type": object["type"], "name": object["name"]})
		}
		sort.SliceStable(group, func(left, right int) bool {
			return fmt.Sprint(group[left]["name"]) < fmt.Sprint(group[right]["name"])
		})
		for _, entry := range group {
			result = append(result, entry)
		}
	}
	_ = groupOrder
	return result
}
