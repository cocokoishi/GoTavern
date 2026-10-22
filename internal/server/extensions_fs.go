package server

// Filesystem-only pinned extension routes: /discover, /move and /delete.
// See extensions.go for the route table and the known gaps.

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"

	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/upstream"
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

// embeddedPinnedExtensionsRoot is the same directory as
// pinnedExtensionsRelativePath inside the embedded vendored tree. It is a
// separate literal because embed.FS paths are always slash-separated, while the
// filesystem form must be native (filepath.Join yields backslashes on Windows).
func embeddedPinnedExtensionsRoot() string {
	return "public/scripts/extensions"
}

// listEmbeddedPinnedExtensionFolders applies the pinned filter chain to the
// embedded tree: directory-only, the `third-party` container excluded, and a
// manifest.json present. It is the same three predicates listPinnedExtensionFolders
// applies to disk, read through fs.ReadDir/fs.Stat on upstream.Assets, which
// returns entries sorted by name for the same reason os.ReadDir does.
//
// The two pinned predicates that cannot be expressed on embed.FS and cannot fire
// on it either: statSync().isDirectory() follows symlinks, and a tree generated
// by go:embed contains no symlinks; existsSync(manifest.json) is true for a
// directory of that name, and fs.Stat succeeds on one too.
func listEmbeddedPinnedExtensionFolders() ([]string, error) {
	root := embeddedPinnedExtensionsRoot()
	entries, err := fs.ReadDir(upstream.Assets, root)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() {
			continue
		}
		// extensions.js:509 excludes the third-party container itself, and does
		// so BEFORE the manifest filter, because it holds user extensions that
		// are listed by the local/global groups instead.
		if name == "third-party" {
			continue
		}
		if _, err := fs.Stat(upstream.Assets, path.Join(root, name, "manifest.json")); err != nil {
			continue
		}
		names = append(names, name)
	}
	return names, nil
}

// pinnedSystemExtensionNames returns the system (built-in) group of the pinned
// /discover listing.
//
// PRECEDENCE, and why it is this one. static.go documents the frontend
// precedence for FILES: read <InstallRoot>/public/<path> from disk first, fall
// back to the embedded tree. This is the same order for the system DIRECTORY,
// with one deliberate asymmetry:
//
//   - When the on-disk directory yields at least one pinned system extension, it
//     is authoritative and nothing from the embedded tree is added or removed.
//     That is the state every real install is in — pinned's checkout always
//     carries public/scripts/extensions — and it keeps the answer byte-identical
//     to pinned's, including for a user who removed a built-in folder, whose
//     removal pinned honours.
//   - Only when the on-disk directory yields NOTHING (absent, or present but
//     empty of pinned system extensions) does the embedded tree answer.
//
// The second case is not a hypothetical: startup mirrors pinned
// ensurePublicDirectoriesExist (src/users.js:113-118, mkdirSync recursive over
// every PUBLIC_DIRECTORIES entry), so a release-shaped install — binary,
// launcher, LICENSE, THIRD_PARTY_NOTICES, tokenizers/ and BUILD-INFO, no
// public/ — gets an EMPTY <InstallRoot>/public/scripts/extensions containing
// only the empty third-party container. Pinned cannot be in that state, because
// its built-ins are tracked files in the directory it recreates; answering the
// embedded list is therefore the faithful answer for the state GoTavern's own
// release layout produces, and answering [] made the pinned frontend load no
// built-in extension at all (measured: 2 /scripts/extensions/* requests instead
// of 109, and an empty system list on the wire).
//
// A thrown readdirSync (extensions.js:507) reaches Express finalhandler as a 500;
// a MISSING directory is answered from the embedded tree instead, because that is
// a layout state GoTavern owns rather than a pinned state. Any other error still
// propagates as the route's 500.
func pinnedSystemExtensionNames(directory string) ([]string, error) {
	names, err := listPinnedExtensionFolders(directory)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
	} else {
		names = withoutThirdParty(names)
		if len(names) > 0 {
			return names, nil
		}
	}
	return listEmbeddedPinnedExtensionFolders()
}

// withoutThirdParty applies extensions.js:509 to a directory listing. Pinned
// applies it to the system listing only: the local and global groups each
// describe one extension inside third-party.
func withoutThirdParty(names []string) []string {
	result := make([]string, 0, len(names))
	for _, name := range names {
		if name == "third-party" {
			continue
		}
		result = append(result, name)
	}
	return result
}

func (runtime *accountRuntime) serveExtensionDiscover(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	localDirectory := directories["extensions"]
	globalDirectory := pinnedGlobalExtensionsDirectory(runtime.options)
	// extensions.js:481-483 creates the user extensions directory before listing
	// it.
	if err := ensureExtensionDirectory(localDirectory); err != nil {
		respondExtensionServerError(w)
		return
	}
	// extensions.js:485-487 does the same for the global directory, and mkdirSync
	// is not recursive there, so the pinned call fails with ENOENT when its parent
	// does not exist. GoTavern does not reproduce that failure: a runtime without a
	// physical public/ tree is a permitted layout (ARCHITECTURE.md:458, static.go),
	// and pinned's own startup would have created the whole chain recursively
	// (src/users.js:116). Creating the parent here would be a side effect pinned
	// never performs FROM THIS ROUTE, so it is skipped rather than faked.
	if extensionIsDirectory(pinnedExtensionsDirectory(runtime.options)) {
		if err := ensureExtensionDirectory(globalDirectory); err != nil {
			respondExtensionServerError(w)
			return
		}
	}

	builtInNames, err := pinnedSystemExtensionNames(pinnedExtensionsDirectory(runtime.options))
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
		// A release-shaped install has no global extensions directory and none is
		// created for it above, so the pinned readdirSync(ENOENT) that would answer
		// 500 is reached by a layout GoTavern owns rather than by a pinned state:
		// there is nothing to list.
		if !errors.Is(err, fs.ErrNotExist) {
			respondExtensionServerError(w)
			return
		}
		globalNames = nil
	}

	result := orderedNodeJSON{kind: 'a', array: make([]orderedNodeJSON, 0, len(builtInNames)+len(userNames)+len(globalNames))}
	appendEntry := func(kind, name string) {
		entry := nodeObject()
		entry.setMember("type", nodeString(kind))
		entry.setMember("name", nodeString(name))
		result.array = append(result.array, entry)
	}
	for _, name := range builtInNames {
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
