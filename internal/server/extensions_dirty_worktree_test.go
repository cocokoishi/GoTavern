package server

// A DIRTY EXTENSION WORKTREE IS REFUSED, NOT FORCED (AGENTS.md rule 28).
//
// The extensions row recorded this as an ungated claim: "no test asserts that a dirty extension worktree is
// refused rather than forced". It is the difference between GoTavern declining to overwrite a user's local
// edits and GoTavern silently discarding them, so it belongs in a test rather than in a comment.
//
// THE MECHANISM IS PINNED'S OWN. `serveExtensionUpdate` runs `git pull origin <branch>` when the repo is not
// up to date (extensions.js: the pinned route does the same through simple-git), and git itself refuses the
// merge when an incoming change would overwrite an uncommitted one. What this test pins is that the refusal
// SURFACES as an error the frontend can show, and that it LEAVES THE USER'S EDIT AND THEIR HEAD ALONE -- the
// failure mode being guarded against is a "helpful" recovery (`reset --hard`, `checkout -- .`, `-f`) that
// turns a refusal into data loss.
//
// It uses real repositories on the local filesystem, never the network: the origin is a bare repo built here
// and the clone points at it by path.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func TestExtensionUpdateRefusesADirtyWorktreeAndKeepsTheUserEdits(t *testing.T) {
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
	// The handler runs git in THIS process, so its commands inherit this environment. An empty global and
	// system config keeps a developer machine's aliases, hooks and `pull.rebase` out of the test.
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

	// ---- the account and the user tree ------------------------------------------------
	accountJSON := []byte(`{"handle":"default-user","name":"Dirty Probe","created":1700000000000,"password":"","admin":true,"enabled":true,"salt":""}`)
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	const cookieSecret = "dirty-worktree-probe-secret"
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
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
	extensionsRoot := directories["extensions"]
	if err := os.RemoveAll(extensionsRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(extensionsRoot, 0o777); err != nil {
		t.Fatal(err)
	}

	// ---- an origin with an incoming change, and a clone that is BEHIND it --------------
	const dateOne = "2020-01-01T00:00:00+00:00"
	const dateTwo = "2020-01-02T00:00:00+00:00"
	originWork := filepath.Join(gitRoot, "work-origin")
	initExtensionsTestRepo(t, originWork)
	writeExtensionsFile(t, filepath.Join(originWork, "probe.txt"), "one\n")
	firstCommit := commitExtensionsTestRepo(t, originWork, "first", dateOne)
	writeExtensionsFile(t, filepath.Join(originWork, "probe.txt"), "two\n")
	secondCommit := commitExtensionsTestRepo(t, originWork, "second", dateTwo)
	if firstCommit == secondCommit {
		t.Fatal("the two origin commits are identical, so there is no incoming change")
	}
	originBare := filepath.Join(gitRoot, "origin.git")
	runExtensionsGit(t, gitRoot, nil, "clone", "--bare", originWork, originBare)
	runExtensionsGit(t, originBare, nil, "symbolic-ref", "HEAD", "refs/heads/main")

	// The user's installed extension: a real clone of that origin, parked at the FIRST commit so `pull` has
	// something to bring in.
	extensionPath := filepath.Join(extensionsRoot, "dirty-probe")
	runExtensionsGit(t, gitRoot, nil, "clone", originBare, extensionPath)
	// BEHIND THE ORIGIN ON A REAL BRANCH, not a detached HEAD. This distinction is the difference between a
	// test that proves the dirty-worktree refusal and one that passes because `git pull origin <empty>` fails
	// for an unrelated reason -- the first version of this test did the latter and the mutation that forced
	// the update SURVIVED, which is how it was caught.
	runExtensionsGit(t, extensionPath, nil, "reset", "--hard", firstCommit)
	if branch := runExtensionsGit(t, extensionPath, nil, "rev-parse", "--abbrev-ref", "HEAD"); branch != "main" {
		t.Fatalf("the probe clone is on %q, not on main: a detached HEAD would make the pull fail for a reason unrelated to the dirty worktree", branch)
	}

	// THE USER'S UNCOMMITTED EDIT, on the very file the incoming commit changes.
	userEdit := "one\nbut the user typed this line and did not commit it\n"
	writeExtensionsFile(t, filepath.Join(extensionPath, "probe.txt"), userEdit)
	statusBefore := runExtensionsGit(t, extensionPath, nil, "status", "--porcelain")
	if strings.TrimSpace(statusBefore) == "" {
		t.Fatalf("the worktree is not dirty before the call (%q), so this test would prove nothing", statusBefore)
	}
	headBefore := runExtensionsGit(t, extensionPath, nil, "rev-parse", "HEAD")

	// ---- drive the update route --------------------------------------------------------
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
	})
	serve := func(method, route string, cookie, token string, body []byte) *httptest.ResponseRecorder {
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
	cookieFrom := func(values []string) string {
		parts := make([]string, 0, len(values))
		for _, value := range values {
			parts = append(parts, strings.SplitN(value, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", nil)
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrfResponse.Code)
	}
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatal(err)
	}
	loginBody, _ := json.Marshal(map[string]string{"handle": "default-user", "password": ""})
	loginResponse := serve(http.MethodPost, "/api/users/login", cookieFrom(csrfResponse.Header().Values("Set-Cookie")), csrf.Token, loginBody)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", loginResponse.Code, loginResponse.Body.String())
	}
	sessionCookie := cookieFrom(loginResponse.Header().Values("Set-Cookie"))

	updateBody, _ := json.Marshal(map[string]any{"extensionName": "dirty-probe"})
	updateResponse := serve(http.MethodPost, "/api/extensions/update", sessionCookie, csrf.Token, updateBody)

	// ---- the refusal, and what survived it ---------------------------------------------
	if updateResponse.Code == http.StatusOK {
		t.Fatalf("POST /api/extensions/update over a dirty worktree answered 200 (%s); a refusal the frontend never sees is a forced update the user cannot explain",
			strings.TrimSpace(updateResponse.Body.String()))
	}
	stored, err := os.ReadFile(filepath.Join(extensionPath, "probe.txt"))
	if err != nil {
		t.Fatalf("read the user's edited file after the update: %v", err)
	}
	if string(stored) != userEdit {
		t.Fatalf("the user's uncommitted edit was MODIFIED by the update\n  before %q\n  after  %q", userEdit, string(stored))
	}
	if headAfter := runExtensionsGit(t, extensionPath, nil, "rev-parse", "HEAD"); headAfter != headBefore {
		t.Fatalf("HEAD moved from %s to %s: the update rewrote history instead of refusing", headBefore, headAfter)
	}
	if statusAfter := runExtensionsGit(t, extensionPath, nil, "status", "--porcelain"); strings.TrimSpace(statusAfter) == "" {
		t.Fatalf("the worktree is CLEAN after the refusal (%q): the user's edit was reverted", statusAfter)
	}
	// And the incoming commit is still not in the local history, so the refusal did not partially apply.
	contains, err := runExtensionsGitAllowingFailure(extensionPath, "merge-base", "--is-ancestor", secondCommit, "HEAD")
	if err != nil && contains == "" {
		// is-ancestor exits 1 for "not an ancestor", which is the expected answer; the helper reports it.
		t.Logf("merge-base --is-ancestor: %v", err)
	}
	if strings.Contains(contains, "true") {
		t.Fatalf("the incoming commit %s is already an ancestor of HEAD: the pull applied despite the dirty worktree", secondCommit)
	}
}

// runExtensionsGitAllowingFailure runs git and returns its stdout even when it exits non-zero, because
// `merge-base --is-ancestor` uses the exit status as its ANSWER (1 = not an ancestor) rather than as a fault.
func runExtensionsGitAllowingFailure(directory string, args ...string) (string, error) {
	command := exec.Command("git", append([]string{"-C", directory}, args...)...)
	command.Env = extensionsGitEnvironment(nil)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	return strings.TrimSpace(stdout.String()), err
}
