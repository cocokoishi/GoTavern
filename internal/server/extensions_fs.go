package server

// Filesystem-only pinned extension routes: /discover, /move and /delete.
// See extensions.go for the route table and the known gaps.

import (
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// listPinnedExtensionFolders mirrors the pinned
// `readdirSync(dir).filter(statSync(...).isDirectory()).filter(hasManifest)`
// chain. os.ReadDir already returns entries sorted by name; the pinned
// readdirSync order is a host filesystem property, which the oracle records as
// an unordered set (see extensions.go).
func listPinnedExtensionFolders(directory string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		absolute := filepath.Join(directory, entry.Name())
		// The pinned filter is statSync().isDirectory(), which follows symlinks.
		info, err := os.Stat(absolute)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			continue
		}
		if !extensionExists(filepath.Join(absolute, "manifest.json")) {
			continue
		}
		names = append(names, entry.Name())
	}
	return names, nil
}

func (runtime *accountRuntime) serveExtensionDiscover(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	localDirectory := directories["extensions"]
	globalDirectory := pinnedGlobalExtensionsDirectory(runtime.options)
	// extensions.js:481-487 creates both directories before listing them.
	if err := ensureExtensionDirectory(localDirectory); err != nil {
		respondExtensionServerError(w)
		return
	}
	if err := ensureExtensionDirectory(globalDirectory); err != nil {
		respondExtensionServerError(w)
		return
	}

	builtInNames, err := listPinnedExtensionFolders(pinnedExtensionsDirectory(runtime.options))
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	userNames, err := listPinnedExtensionFolders(localDirectory)
	if err != nil {
		respondExtensionServerError(w)
		return
	}
	globalNames, err := listPinnedExtensionFolders(globalDirectory)
	if err != nil {
		respondExtensionServerError(w)
		return
	}

	result := orderedNodeJSON{kind: 'a', array: make([]orderedNodeJSON, 0, len(builtInNames)+len(userNames)+len(globalNames))}
	appendEntry := func(kind, name string) {
		entry := nodeObject()
		entry.setMember("type", nodeString(kind))
		entry.setMember("name", nodeString(name))
		result.array = append(result.array, entry)
	}
	for _, name := range builtInNames {
		// extensions.js:509 excludes the third-party container itself.
		if name == "third-party" {
			continue
		}
		appendEntry("system", name)
	}
	userEntries := make([]string, 0, len(userNames))
	for _, name := range userNames {
		appendEntry("local", "third-party/"+name)
		userEntries = append(userEntries, "third-party/"+name)
	}
	for _, name := range globalNames {
		// extensions.js:527 suppresses a global extension that the user also has.
		candidate := "third-party/" + name
		shadowed := false
		for _, existing := range userEntries {
			if existing == candidate {
				shadowed = true
				break
			}
		}
		if shadowed {
			continue
		}
		appendEntry("global", candidate)
	}
	respondOrderedNodeJSON(w, http.StatusOK, result)
}

func (runtime *accountRuntime) serveExtensionMove(w http.ResponseWriter, request *http.Request) {
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
	source := nodeGet(body, "source")
	destination := nodeGet(body, "destination")
	sanitized := startup.SanitizeUserFilename(name)
	if sanitized == "" || !jsTruthy(source) || !jsTruthy(destination) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Bad Request: A valid extensionName, source, and destination are required in the request body.")
		return
	}
	if !extensionAccountIsAdmin(account) {
		respondText(w, http.StatusForbidden, "text/html; charset=utf-8", "Forbidden: No permission to move extensions.")
		return
	}
	sourceLocation := extensionRequestLocation(runtime.options, directories, source)
	destinationLocation := extensionRequestLocation(runtime.options, directories, destination)
	sourcePath := filepath.Join(sourceLocation.resolved, sanitized)
	destinationPath := filepath.Join(destinationLocation.resolved, sanitized)

	if !extensionExists(sourcePath) || !extensionIsDirectory(sourcePath) {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", "Source directory does not exist.")
		return
	}
	if extensionExists(destinationPath) {
		respondText(w, http.StatusConflict, "text/html; charset=utf-8", "Destination directory already exists.")
		return
	}
	// extensions.js:361-364 compares the raw request values. When they are equal
	// the two paths are equal as well, so the previous existsSync check has
	// already answered; the branch is kept for structural fidelity.
	if nodeStrictEqual(source, destination) {
		respondText(w, http.StatusConflict, "text/html; charset=utf-8", "Source and destination directories are the same.")
		return
	}
	if err := copyExtensionTree(sourcePath, destinationPath); err != nil {
		respondExtensionServerError(w)
		return
	}
	if err := os.RemoveAll(sourcePath); err != nil {
		respondExtensionServerError(w)
		return
	}
	serveNoContent(w)
}

func (runtime *accountRuntime) serveExtensionDelete(w http.ResponseWriter, request *http.Request) {
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
		respondText(w, http.StatusForbidden, "text/html; charset=utf-8", "Forbidden: No permission to delete global extensions.")
		return
	}
	location := extensionBaseLocation(runtime.options, directories, global)
	extensionPath := filepath.Join(location.resolved, sanitized)
	displayPath := filepath.Join(location.display, sanitized)
	if !extensionExists(extensionPath) {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", "Directory does not exist at "+displayPath)
		return
	}
	if err := removeExtensionTree(extensionPath, false); err != nil {
		respondExtensionServerError(w)
		return
	}
	respondText(w, http.StatusOK, "text/html; charset=utf-8", "Extension has been deleted at "+displayPath)
}

// nodeStrictEqual mirrors JavaScript's === for two decoded JSON values.
func nodeStrictEqual(left, right orderedNodeJSON) bool {
	if left.kind != right.kind {
		return false
	}
	switch left.kind {
	case 's':
		return left.scalar.(string) == right.scalar.(string)
	case 'b':
		return left.scalar.(bool) == right.scalar.(bool)
	case 'v':
		return left.scalar.(float64) == right.scalar.(float64)
	case 'n', nodeUndefinedKind:
		return true
	default:
		// Objects and arrays are compared by reference, which is never true for
		// two distinct literals.
		return false
	}
}

// copyExtensionTree mirrors fs.cpSync(source, destination, {recursive: true,
// force: true}). Symlinks are recreated rather than dereferenced, which is the
// pinned default.
func copyExtensionTree(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(source)
		if err != nil {
			return err
		}
		return os.Symlink(target, destination)
	}
	if !info.IsDir() {
		return copyExtensionFile(source, destination, info.Mode())
	}
	if err := os.MkdirAll(destination, info.Mode().Perm()|0o200); err != nil {
		return err
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := copyExtensionTree(filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func copyExtensionFile(source, destination string, mode fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o777); err != nil {
		return err
	}
	from, err := os.Open(source)
	if err != nil {
		return err
	}
	defer from.Close()
	to, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode.Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(to, from); err != nil {
		to.Close()
		return err
	}
	return to.Close()
}

// sortedExtensionNames is used by the tests and the oracle comparison to state
// explicitly that pinned /discover order is a host filesystem property.
func sortedExtensionNames(names []string) []string {
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	return sorted
}
