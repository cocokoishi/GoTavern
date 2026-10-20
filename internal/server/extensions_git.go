package server

// Git-backed pinned extension routes: /install, /update, /branches, /switch and
// /version. See extensions.go for the route table and the known gaps.
//
// The pinned endpoints drive git through simple-git (src/endpoints/extensions.js
// imports it directly for update/branches/switch/version, and through
// createGitClient for install). The commands and parsers below mirror the
// simple-git 3.x tasks the pinned code reaches:
//
//	git.branch()            -> git branch -v -a   (parse-branch.ts)
//	git.branchLocal()       -> git branch -v
//	git.branch(['-r','--list','origin/*'])
//	                        -> git branch -v -r --list origin/*
//	git.checkIsRepo(root)   -> git rev-parse --git-dir  == '.' or '.git'
//	git.revparse(['HEAD'])  -> git rev-parse HEAD
//	git.log({from,to})      -> git log ... <from>...<to>  (total commit count)
//	git.getRemotes(true)    -> git remote -v
//	git.fetch('origin')     -> git fetch origin
//	git.pull('origin', b)   -> git pull origin <b>
//	git.clone(url, p, o)    -> git clone --depth=<n> [--branch=<b>] <url> <p>

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedGitBlockTimeout mirrors OPTIONS in extensions.js:17.
const pinnedGitBlockTimeout = 5 * time.Minute

var (
	pinnedGitDetachedBranchPattern = regexp.MustCompile(`^([*+]\s)?\((?:HEAD )?detached (?:from|at) (\S+)\)\s+([a-z0-9]+)\s(.*)$`)
	pinnedGitBranchPattern         = regexp.MustCompile(`^([*+]\s)?(\S+)\s+([a-z0-9]+)\s?(.*)$`)
)

type pinnedGitBranchEntry struct {
	current bool
	commit  string
	name    string
	label   string
}

// runPinnedGit executes one git command. dir is passed with -C so the command
// never depends on the server process working directory.
func runPinnedGit(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), pinnedGitBlockTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	command.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"GCM_INTERACTIVE=never",
		"LC_ALL=C",
	)
	if err := command.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// runPinnedGitIn executes one git command in an explicit working directory,
// which is what simpleGit() without a baseDir does for clone.
func runPinnedGitIn(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), pinnedGitBlockTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = dir
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	command.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"GCM_INTERACTIVE=never",
		"LC_ALL=C",
	)
	if err := command.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// pinnedGitExecutableAvailable mirrors commandExistsSync('git') in
// src/git/client.js:26.
func pinnedGitExecutableAvailable() bool {
	_, err := exec.LookPath("git")
	return err == nil
}

// parsePinnedGitBranchSummary mirrors simple-git's parseBranchSummary. simple-git
// runs every line through String.prototype.trim() and drops empty lines before
// matching (dist/cjs/index.js toLinesWithContent), which is why an unmarked
// branch line such as "  main abc1234 subject" matches at all. Lines matching
// neither parser are ignored, exactly as parseStringResponse does.
func parsePinnedGitBranchSummary(output string) []pinnedGitBranchEntry {
	entries := make([]pinnedGitBranchEntry, 0)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if match := pinnedGitDetachedBranchPattern.FindStringSubmatch(line); match != nil {
			entries = append(entries, pinnedGitBranchEntry{
				current: match[1] == "* ",
				name:    match[2],
				commit:  match[3],
				label:   match[4],
			})
			continue
		}
		if match := pinnedGitBranchPattern.FindStringSubmatch(line); match != nil {
			entries = append(entries, pinnedGitBranchEntry{
				current: match[1] == "* ",
				name:    match[2],
				commit:  match[3],
				label:   match[4],
			})
		}
	}
	return entries
}

// pinnedGitCurrentBranch mirrors git.branch().current.
func pinnedGitCurrentBranch(entries []pinnedGitBranchEntry) string {
	for _, entry := range entries {
		if entry.current {
			return entry.name
		}
	}
	return ""
}

// pinnedGitIsRepoRoot mirrors checkIsRepoRootTask: `git rev-parse --git-dir`
// must answer '.' or '.git'. simple-git resolves false for exit code 128 when
// git reports "not a git repository"; GoTavern treats every failure of the
// command the same way, because the pinned text check is locale dependent.
func pinnedGitIsRepoRoot(directory string) bool {
	output, err := runPinnedGit(directory, "rev-parse", "--git-dir")
	if err != nil {
		return false
	}
	trimmed := strings.TrimSpace(output)
	return trimmed == "." || trimmed == ".git"
}

// pinnedGitLogTotal mirrors git.log({ from, to }).total: the pinned call leaves
// `symmetric` at its default, so simple-git builds the three-dot range
// (parse-log-options: `opt.symmetric !== false ? '...' : '..'`).
func pinnedGitLogTotal(directory, from, to string) (int, error) {
	output, err := runPinnedGit(directory, "rev-list", "--count", from+"..."+to)
	if err != nil {
		return 0, err
	}
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return 0, nil
	}
	var count int
	if _, err := fmt.Sscanf(trimmed, "%d", &count); err != nil {
		return 0, err
	}
	return count, nil
}

// pinnedGitFetchURL mirrors getRemotes(true)[0].refs.fetch.
func pinnedGitFetchURL(directory string) (string, error) {
	output, err := runPinnedGit(directory, "remote", "-v")
	if err != nil {
		return "", err
	}
	seen := make(map[string]bool)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(strings.TrimSuffix(line, "\r"))
		if len(fields) < 3 {
			continue
		}
		if seen[fields[0]] {
			continue
		}
		seen[fields[0]] = true
		if fields[2] == "(fetch)" {
			return fields[1], nil
		}
	}
	return "", nil
}

// checkPinnedRepoIsUpToDate mirrors checkIfRepoIsUpToDate (extensions.js:41-64).
func checkPinnedRepoIsUpToDate(extensionPath string) (bool, string, error) {
	if _, err := runPinnedGit(extensionPath, "fetch", "origin"); err != nil {
		return false, "", err
	}
	summary, err := runPinnedGit(extensionPath, "branch", "-v", "-a")
	if err != nil {
		return false, "", err
	}
	currentBranch := pinnedGitCurrentBranch(parsePinnedGitBranchSummary(summary))
	head, err := runPinnedGit(extensionPath, "rev-parse", "HEAD")
	if err != nil {
		return false, "", err
	}
	head = strings.TrimSpace(head)
	total, err := pinnedGitLogTotal(extensionPath, head, "origin/"+currentBranch)
	if err != nil {
		return false, "", err
	}
	remoteURL, err := pinnedGitFetchURL(extensionPath)
	if err != nil {
		return false, "", err
	}
	if remoteURL == "" {
		// The pinned `remotes.length === 0` branch is unreachable in practice:
		// git.fetch('origin') has already thrown when no origin remote exists.
		return true, "", nil
	}
	return total == 0, remoteURL, nil
}

// jsStringOf mirrors JavaScript's String(value) for a decoded JSON value. The
// second result is false when ToString throws, which happens for an object with
// a non-callable `toString` member. `undefined` also fails here because the
// shared helper rejects it; every caller in this domain has already established
// that the value is truthy or a parsed URL, so ToString never sees undefined.
func jsStringOf(value orderedNodeJSON) (string, bool) {
	text, err := value.javascriptString()
	if err != nil {
		return "", false
	}
	return text, true
}

// isValidPinnedURL mirrors isValidUrl (src/util.js:993-1000): `new URL(url)`
// must not throw. A non-string value is stringified first, exactly as the URL
// constructor does.
func isValidPinnedURL(value orderedNodeJSON) bool {
	text, ok := jsStringOf(value)
	if !ok {
		return false
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.Scheme == "" {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "ws", "wss", "ftp":
		// WHATWG special schemes require a non-empty host.
		return parsed.Host != ""
	case "file":
		return true
	default:
		return true
	}
}

// pinnedURLPathname mirrors new URL(url).pathname: the percent-encoded path,
// never decoded.
func pinnedURLPathname(value orderedNodeJSON) (string, bool) {
	text, ok := jsStringOf(value)
	if !ok {
		return "", false
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return "", false
	}
	escaped := parsed.EscapedPath()
	if escaped == "" {
		return "/", true
	}
	return escaped, true
}

// pinnedURLHref mirrors new URL(url).href closely enough for the clone target.
func pinnedURLHref(value orderedNodeJSON) (string, bool) {
	text, ok := jsStringOf(value)
	if !ok {
		return "", false
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return "", false
	}
	return parsed.String(), true
}

func pinnedURLScheme(value orderedNodeJSON) string {
	text, _ := jsStringOf(value)
	parsed, err := url.Parse(text)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Scheme)
}

// pinnedGitBranchNames returns the branch names in pinned summary order.
func pinnedGitBranchNames(entries []pinnedGitBranchEntry) []string {
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.name)
	}
	return names
}

func (runtime *accountRuntime) serveExtensionVersion(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	body, ok := extensionRequestBody(w, request)
	if !ok {
		return
	}
	name, isString := extensionStringMember(body, "extensionName")
	if !isString {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid extensionName is required in the request body.")
		return
	}
	sanitized := startup.SanitizeUserFilename(name)
	if sanitized == "" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid extensionName is required in the request body.")
		return
	}
	// extensions.js:387-432 has no global/admin guard: a non-admin user may read
	// the version of a global extension.
	global := jsTruthy(nodeGet(body, "global"))
	location := extensionBaseLocation(runtime.options, directories, global)
	extensionPath := filepath.Join(location.resolved, sanitized)
	if !extensionExists(extensionPath) {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", "Directory does not exist at "+filepath.Join(location.display, sanitized))
		return
	}
	if !pinnedGitIsRepoRoot(extensionPath) {
		respondPinnedExtensionVersion(w, "", "", true, "")
		return
	}
	head, err := runPinnedGit(extensionPath, "rev-parse", "HEAD")
	if err != nil {
		respondPinnedExtensionVersion(w, "", "", true, "")
		return
	}
	currentCommitHash := strings.TrimSpace(head)
	summary, err := runPinnedGit(extensionPath, "branch", "-v", "-a")
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	currentBranchName := pinnedGitCurrentBranch(parsePinnedGitBranchSummary(summary))
	if _, err := runPinnedGit(extensionPath, "fetch", "origin"); err != nil {
		respondExtensionServerError(w)
		return
	}
	isUpToDate, remoteURL, err := checkPinnedRepoIsUpToDate(extensionPath)
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	respondPinnedExtensionVersion(w, currentBranchName, currentCommitHash, isUpToDate, remoteURL)
}

func respondPinnedExtensionVersion(w http.ResponseWriter, branch, commit string, isUpToDate bool, remoteURL string) {
	response := nodeObject()
	response.setMember("currentBranchName", nodeString(branch))
	response.setMember("currentCommitHash", nodeString(commit))
	response.setMember("isUpToDate", nodeBool(isUpToDate))
	response.setMember("remoteUrl", nodeString(remoteURL))
	respondOrderedNodeJSON(w, http.StatusOK, response)
}

func (runtime *accountRuntime) serveExtensionUpdate(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	body, ok := extensionRequestBody(w, request)
	if !ok {
		return
	}
	name, isString := extensionStringMember(body, "extensionName")
	if !isString {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid extensionName is required in the request body.")
		return
	}
	sanitized := startup.SanitizeUserFilename(name)
	if sanitized == "" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid extensionName is required in the request body.")
		return
	}
	global := jsTruthy(nodeGet(body, "global"))
	if global && !extensionAccountIsAdmin(account) {
		respondText(w, http.StatusForbidden, "text/html; charset=utf-8", "Forbidden: No permission to update global extensions.")
		return
	}
	location := extensionBaseLocation(runtime.options, directories, global)
	extensionPath := filepath.Join(location.resolved, sanitized)
	if !extensionExists(extensionPath) {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", "Directory does not exist at "+filepath.Join(location.display, sanitized))
		return
	}
	isUpToDate, remoteURL, err := checkPinnedRepoIsUpToDate(extensionPath)
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	if !pinnedGitIsRepoRoot(extensionPath) {
		respondExtensionServerError(w)
		return
	}
	summary, err := runPinnedGit(extensionPath, "branch", "-v", "-a")
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	currentBranch := pinnedGitCurrentBranch(parsePinnedGitBranchSummary(summary))
	if !isUpToDate {
		if _, err := runPinnedGit(extensionPath, "pull", "origin", currentBranch); err != nil {
			respondExtensionServerError(w)
			return
		}
	}
	if _, err := runPinnedGit(extensionPath, "fetch", "origin"); err != nil {
		respondExtensionServerError(w)
		return
	}
	head, err := runPinnedGit(extensionPath, "rev-parse", "HEAD")
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	fullCommitHash := strings.TrimSpace(head)
	shortCommitHash := fullCommitHash
	if len(shortCommitHash) > 7 {
		// extensions.js:208 hardcodes slice(0, 7), so the abbreviation length is
		// not affected by core.abbrev or repository size.
		shortCommitHash = shortCommitHash[:7]
	}
	response := nodeObject()
	response.setMember("shortCommitHash", nodeString(shortCommitHash))
	response.setMember("extensionPath", nodeString(filepath.Join(location.display, sanitized)))
	response.setMember("isUpToDate", nodeBool(isUpToDate))
	response.setMember("remoteUrl", nodeString(remoteURL))
	respondOrderedNodeJSON(w, http.StatusOK, response)
}

func (runtime *accountRuntime) serveExtensionBranches(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	body, ok := extensionRequestBody(w, request)
	if !ok {
		return
	}
	name, isString := extensionStringMember(body, "extensionName")
	if !isString {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid extensionName is required in the request body.")
		return
	}
	sanitized := startup.SanitizeUserFilename(name)
	if sanitized == "" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid extensionName is required in the request body.")
		return
	}
	global := jsTruthy(nodeGet(body, "global"))
	if global && !extensionAccountIsAdmin(account) {
		respondText(w, http.StatusForbidden, "text/html; charset=utf-8", "Forbidden: No permission to list branches of global extensions.")
		return
	}
	location := extensionBaseLocation(runtime.options, directories, global)
	extensionPath := filepath.Join(location.resolved, sanitized)
	if !extensionExists(extensionPath) {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", "Directory does not exist at "+filepath.Join(location.display, sanitized))
		return
	}
	shallowOutput, err := runPinnedGit(extensionPath, "rev-parse", "--is-shallow-repository")
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	if strings.TrimSpace(shallowOutput) == "true" {
		if _, err := runPinnedGit(extensionPath, "fetch", "origin", "--unshallow"); err != nil {
			respondExtensionServerError(w)
			return
		}
	}
	if _, err := runPinnedGit(extensionPath, "remote", "set-branches", "origin", "*"); err != nil {
		respondExtensionServerError(w)
		return
	}
	if _, err := runPinnedGit(extensionPath, "fetch", "origin"); err != nil {
		respondExtensionServerError(w)
		return
	}
	localOutput, err := runPinnedGit(extensionPath, "branch", "-v")
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	remoteOutput, err := runPinnedGit(extensionPath, "branch", "-v", "-r", "--list", "origin/*")
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	entries := append(parsePinnedGitBranchSummary(localOutput), parsePinnedGitBranchSummary(remoteOutput)...)
	result := orderedNodeJSON{kind: 'a', array: make([]orderedNodeJSON, 0, len(entries))}
	for _, entry := range entries {
		item := nodeObject()
		item.setMember("current", nodeBool(entry.current))
		item.setMember("commit", nodeString(entry.commit))
		item.setMember("name", nodeString(entry.name))
		item.setMember("label", nodeString(entry.label))
		result.array = append(result.array, item)
	}
	respondOrderedNodeJSON(w, http.StatusOK, result)
}

func (runtime *accountRuntime) serveExtensionSwitch(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	body, ok := extensionRequestBody(w, request)
	if !ok {
		return
	}
	name, isString := extensionStringMember(body, "extensionName")
	if !isString {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid extensionName is required in the request body.")
		return
	}
	branchValue := nodeGet(body, "branch")
	sanitized := startup.SanitizeUserFilename(name)
	if sanitized == "" || !jsTruthy(branchValue) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid extensionName and branch are required in the request body.")
		return
	}
	global := jsTruthy(nodeGet(body, "global"))
	if global && !extensionAccountIsAdmin(account) {
		respondText(w, http.StatusForbidden, "text/html; charset=utf-8", "Forbidden: No permission to switch branches of global extensions.")
		return
	}
	location := extensionBaseLocation(runtime.options, directories, global)
	extensionPath := filepath.Join(location.resolved, sanitized)
	if !extensionExists(extensionPath) {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", "Directory does not exist at "+filepath.Join(location.display, sanitized))
		return
	}
	branch, stringified := jsStringOf(branchValue)
	if !stringified {
		respondExtensionServerError(w)
		return
	}
	localOutput, err := runPinnedGit(extensionPath, "branch", "-v")
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	localNames := pinnedGitBranchNames(parsePinnedGitBranchSummary(localOutput))
	if strings.HasPrefix(branch, "origin/") {
		localBranch := strings.Replace(branch, "origin/", "", 1)
		if pinnedGitBranchListContains(localNames, localBranch) {
			if _, err := runPinnedGit(extensionPath, "checkout", localBranch); err != nil {
				respondExtensionServerError(w)
				return
			}
			serveNoContent(w)
			return
		}
		if _, err := runPinnedGit(extensionPath, "checkout", "-b", localBranch, branch); err != nil {
			respondExtensionServerError(w)
			return
		}
		serveNoContent(w)
		return
	}
	if !pinnedGitBranchListContainsStrict(localNames, branchValue) {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", "Branch "+branch+" does not exist locally")
		return
	}
	summary, err := runPinnedGit(extensionPath, "branch", "-v", "-a")
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	if pinnedGitCurrentBranch(parsePinnedGitBranchSummary(summary)) == branch {
		serveNoContent(w)
		return
	}
	if _, err := runPinnedGit(extensionPath, "checkout", branch); err != nil {
		respondExtensionServerError(w)
		return
	}
	serveNoContent(w)
}

// pinnedGitBranchListContains mirrors Array.prototype.includes on branch names
// produced by git, which are always strings.
func pinnedGitBranchListContains(names []string, branch string) bool {
	for _, name := range names {
		if name == branch {
			return true
		}
	}
	return false
}

// pinnedGitBranchListContainsStrict mirrors `branches.all.includes(branch)` for
// a non-string request value, where strict equality can never match a name.
func pinnedGitBranchListContainsStrict(names []string, value orderedNodeJSON) bool {
	if value.kind != 's' {
		return false
	}
	return pinnedGitBranchListContains(names, value.scalar.(string))
}

func (runtime *accountRuntime) serveExtensionInstall(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	body, ok := extensionRequestBody(w, request)
	if !ok {
		return
	}
	global := jsTruthy(nodeGet(body, "global"))
	// extensions.js:96-99 checks the global permission before validating the URL.
	if global && !extensionAccountIsAdmin(account) {
		respondText(w, http.StatusForbidden, "text/html; charset=utf-8", "Forbidden: No permission to install global extensions.")
		return
	}
	urlValue := nodeGet(body, "url")
	if !isValidPinnedURL(urlValue) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid URL is required in the request body.")
		return
	}
	scheme := pinnedURLScheme(urlValue)
	if scheme != "http" && scheme != "https" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: Only HTTP and HTTPS protocols are supported for the Extension URL.")
		return
	}
	// createGitClient() resolves the backend before any filesystem work.
	if !pinnedGitExecutableAvailable() {
		respondExtensionServerError(w)
		return
	}
	if err := ensureExtensionDirectory(directories["extensions"]); err != nil {
		respondExtensionServerError(w)
		return
	}
	if err := ensureExtensionDirectory(pinnedGlobalExtensionsDirectory(runtime.options)); err != nil {
		respondExtensionServerError(w)
		return
	}
	baseLocation := extensionBaseLocation(runtime.options, directories, global)
	pathname, ok := pinnedURLPathname(urlValue)
	if !ok {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid URL is required in the request body.")
		return
	}
	extensionNameSanitized := startup.SanitizeUserFilename(nodeBasenameExt(nodeURLBasename(pathname), ".git"))
	if extensionNameSanitized == "" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Could not determine the extension name from the URL. Please provide a valid git repository URL.")
		return
	}
	extensionPath := filepath.Join(baseLocation.resolved, extensionNameSanitized)
	displayPath := filepath.Join(baseLocation.display, extensionNameSanitized)
	folderName := filepath.Base(extensionPath)
	if extensionExists(extensionPath) {
		respondText(w, http.StatusConflict, "text/html; charset=utf-8", "Directory already exists at "+displayPath)
		return
	}
	cloneURL, ok := pinnedURLHref(urlValue)
	if !ok {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid URL is required in the request body.")
		return
	}
	cloneArgs := []string{"clone", "--depth=1"}
	if branchValue := nodeGet(body, "branch"); jsTruthy(branchValue) {
		branch, stringified := jsStringOf(branchValue)
		if !stringified {
			respondExtensionServerError(w)
			return
		}
		cloneArgs = append(cloneArgs, "--branch="+branch)
	}
	cloneArgs = append(cloneArgs, cloneURL, extensionPath)
	if _, err := runPinnedGitIn(baseLocation.resolved, cloneArgs...); err != nil {
		respondExtensionServerError(w)
		return
	}
	manifest, ok := extensionManifest(extensionPath)
	if !ok || manifest.kind != 'o' {
		// extensions.js:148-150 removes the clone before rethrowing.
		_ = removeExtensionTree(extensionPath, true)
		respondExtensionServerError(w)
		return
	}
	response := nodeObject()
	for _, key := range []string{"version", "author", "display_name"} {
		if member, exists := manifest.member(key); exists {
			response.setMember(key, member)
		}
	}
	response.setMember("extensionPath", nodeString(displayPath))
	response.setMember("folderName", nodeString(folderName))
	respondOrderedNodeJSON(w, http.StatusOK, response)
}
