package server

// Pinned asset download, from src/endpoints/assets.js:190.
//
//	POST /api/assets/download
//
// The fixture is tests/oracle/sillytavern-1.19.0-assets-download.json, recorded by
// tools/probe-assets-download.mjs. It is the specification: FOUR guards, each with its own status, and
// two response shapes. A refusal is `res.sendStatus(status)`, which is NOT an empty body — Express
// sends the status phrase as text/plain with an ETag — while the filename guard is
// `res.status(400).send(message)`, a text/html body whose value is the validator's message.
//
// The outbound request happens ONLY after all four guards, which the fixture records as an outbound
// COUNT per step (zero for every refusal), so a handler that fetched early cannot look correct.
//
// HOST-DEPENDENT BOUNDARY, recorded in the fixture knownDifferences: pinned streams the body into
// assets/temp/<name> with the exclusive flag and only then copies it into the category directory, so
// a failure after the response headers leaves a partial temp file. GoTavern reads the body and writes
// the destination atomically under the user content lock, so no partial file is left. Every end state
// the fixture records is identical; the transient temp artifact is not reproduced.

import (
	"os"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// assetsDownloadMimeTypes is the subset of the `mime-types` database the download route can reach
// through the character branch. Pinned calls mime.lookup(tempPath), which is a STATIC database; Go's
// mime package consults the Windows registry, so using it would make the response Content-Type a
// property of the host. Extensions outside this table fall back to application/octet-stream, which is
// what mime.lookup returns for an unknown extension; the table is not the full database and the
// compat row names that gap.
var assetsDownloadMimeTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".svg":  "image/svg+xml",
	".ico":  "image/vnd.microsoft.icon",
	".mp3":  "audio/mpeg",
	".ogg":  "audio/ogg",
	".oga":  "audio/ogg",
	".opus": "audio/ogg",
	".wav":  "audio/wav",
	".m4a":  "audio/mp4",
	".aac":  "audio/aac",
	".flac": "audio/flac",
	".weba": "audio/webm",
	".mp4":  "video/mp4",
	".webm": "video/webm",
	".mov":  "video/quicktime",
	".json": "application/json",
	".txt":  "text/plain",
	".md":   "text/markdown",
	".csv":  "text/csv",
	".xml":  "application/xml",
	".glb":  "model/gltf-binary",
	".gltf": "model/gltf+json",
	".vrm":  "model/gltf-binary",
	".bin":  "application/octet-stream",
}

// assetsDownloadRemoveTemp reproduces the temp-file lifecycle of assets.js:232-253 without writing
// the transient file: a stale assets/temp/<name> is removed, so the end state matches pinned (the
// temp path is gone) while no partial download can ever be left behind. The removal is under the
// shared user content lock.
func (runtime *accountRuntime) assetsDownloadRemoveTemp(account *storedAccount, directories startup.UserDirectories, filename string) error {
	// The temp DIRECTORY is part of the end state and the replay measured it: pinned's ensureDirectory
	// creates assets/temp before it opens the temp file, unlinks only the FILE afterwards, so the
	// directory survives with nine entries where a tree without it has eight. Leaving it out made the
	// whole-tree assertion fail with "tree has 8 entries, pinned Node left 9".
	if err := os.MkdirAll(filepath.Join(directories["assets"], "temp"), 0o777); err != nil {
		return err
	}
	relative, ok := sdUserRelativePath(directories, filepath.Join(directories["assets"], "temp", filename))
	if !ok {
		return errAssetsLockEscapes
	}
	_, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), relative)
	return err
}

// assetsNullBodyStatus is node-fetch's nullBodyStatus: the statuses whose response carries no body
// object at all, which the pinned route turns into a thrown error.
func assetsNullBodyStatus(status int) bool {
	switch status {
	case http.StatusSwitchingProtocols, http.StatusNoContent, http.StatusResetContent, http.StatusNotModified:
		return true
	}
	return false
}

// assetsDownloadMimeType is `mime.lookup(path) || 'application/octet-stream'`.
func assetsDownloadMimeType(filename string) string {
	if contentType, exists := assetsDownloadMimeTypes[strings.ToLower(filepath.Ext(filename))]; exists {
		return contentType
	}
	return "application/octet-stream"
}

// assetsParseJSURL reproduces the acceptance of `new URL(value)`: a scheme is required, and the
// special schemes require a host (file: does not). It returns nil for anything `new URL` rejects.
func assetsParseJSURL(raw string) *url.URL {
	// WHATWG URL strips leading and trailing C0 controls and spaces before parsing.
	trimmed := strings.Trim(raw, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f ")
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" {
		return nil
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "ws", "wss", "ftp":
		if parsed.Host == "" {
			return nil
		}
	}
	return parsed
}

// assetsIsValidURL is isValidUrl (src/util.js): `new URL(url)` does not throw.
func assetsIsValidURL(value orderedNodeJSON) bool {
	text, err := pinnedJSStringValue(value)
	if err != nil {
		return false
	}
	return assetsParseJSURL(text) != nil
}

// assetsHostFromURL is getHostFromUrl (content-manager.js:958): `new URL(url).hostname`, which is
// lowercased, has no port, and keeps the brackets of an IPv6 literal.
func assetsHostFromURL(raw string) string {
	parsed := assetsParseJSURL(raw)
	if parsed == nil {
		return ""
	}
	hostname := strings.ToLower(parsed.Hostname())
	if strings.Contains(hostname, ":") {
		hostname = "[" + hostname + "]"
	}
	return hostname
}

// assetsHostWhitelisted is isHostWhitelisted (content-manager.js:972): an EXACT match against the
// whitelistImportDomains config list.
func (runtime *accountRuntime) assetsHostWhitelisted(host string) bool {
	for _, allowed := range runtime.options.WhitelistImportDomains {
		if allowed == host {
			return true
		}
	}
	return false
}

// serveAssetsDownload is assets.js:190.
func (runtime *accountRuntime) serveAssetsDownload(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}

	// 192-195: isValidUrl(request.body.url).
	urlNode := sdBodyMember(body, "url")
	if !assetsIsValidURL(urlNode) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	rawURL := searchJSString(urlNode)

	// 200-204: isHostWhitelisted(getHostFromUrl(url)). A policy refusal, so it answers 404 and must
	// not have made an outbound request.
	if !runtime.assetsHostWhitelisted(assetsHostFromURL(rawURL)) {
		backendsStatus(w, http.StatusNotFound)
		return
	}

	// 206-215: the category must be a member of VALID_CATEGORIES.
	category, categoryOK := assetsValidCategory(searchJSString(sdBodyMember(body, "category")))
	if !categoryOK {
		backendsStatus(w, http.StatusBadRequest)
		return
	}

	// 218: ensureFoldersExist runs BEFORE the filename guard, so a refused filename still leaves the
	// category directories created. It throws into the route's catch on failure.
	if err := runtime.assetsEnsureFolders(account, directories); err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}

	// 217-221: validateAssetFileName(request.body.filename). A non-string filename reaches
	// path.extname(undefined), which throws, so it is a 500 rather than a validation message.
	filenameNode := sdBodyMember(body, "filename")
	filename, isString := filenameNode.stringValue()
	if !isString {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if message, valid := assetsValidateFileName(filename); !valid {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", message)
		return
	}

	// 228: the only outbound request, and it happens after every guard.
	response, err := searchFetch(request.Context(), searchRequest{Method: http.MethodGet, URL: rawURL})
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	// `!res.ok || res.body === null`: node-fetch gives a NULL body for 101/204/205/304, so a 204 from
	// the asset host throws into the catch and answers 500 rather than writing an empty file.
	if !sdResponseOK(response) || assetsNullBodyStatus(response.Status) {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	downloaded := response.Body

	// 232-239: pinned writes the bytes to assets/temp/<name> with the exclusive flag — unlinking a
	// stale file of that name first — and removes the temp file once the download is in place. The
	// observable end state is that the temp path does not exist, whether or not it existed before.
	// This runs only AFTER the ok check, so a failed fetch leaves a stale temp file untouched exactly
	// as pinned leaves it.
	if err := runtime.assetsDownloadRemoveTemp(account, directories, filename); err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}

	// 241-248: the character branch answers the downloaded bytes and writes no asset file.
	if category == "character" {
		w.Header().Set("Content-Type", assetsDownloadMimeType(filename))
		w.Header().Set("Content-Length", strconv.Itoa(len(downloaded)))
		w.Header().Set("ETag", expressWeakETag(downloaded))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(downloaded)
		return
	}

	// 250-254: move the download into the asset place. Pinned copies the temp file and unlinks it;
	// GoTavern writes the destination atomically under the shared user content lock, which leaves the
	// same end state without the transient temp file.
	relative, relativeOK := sdUserRelativePath(directories, filepath.Join(directories["assets"], category, filename))
	if !relativeOK {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if err := startup.UpdateUserContentFileIfChanged(runtime.options.DataRoot, account.string("handle"), relative, func([]byte) ([]byte, bool, error) {
		return downloaded, true, nil
	}); err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	backendsStatus(w, http.StatusOK)
}
