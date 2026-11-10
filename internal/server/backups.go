package server

// Pinned chat-backup routes, from src/endpoints/backups.js:
//
//	POST /api/backups/chat/delete    (32)
//	POST /api/backups/chat/download  (54)
//
// The fixture is tests/oracle/sillytavern-1.19.0-backups.json recorded by tools/probe-assets.mjs.
// Both routes sanitize the name with sanitize-filename (startup.SanitizeUserFilename), require the
// resulting base name to start with CHAT_BACKUPS_PREFIX ("chat_"), and answer 500 when the name is
// missing or non-string because sanitize() throws. Deletion reuses startup.DeleteUserFile.
//
// /api/backups/chat/get is IMPLEMENTED in backups_chat_get.go (it reuses the existing pinnedChatInfo port);
// the old "deferred" note here and the fixture's recorded knownDifferences entry are historical and are not a
// current product gap -- the route is registered and replayed by backups_chat_get_test.go and the get->download
// restore round trip is covered by backups_restore_roundtrip_test.go.

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const backupsChatPrefix = "chat_"

func registerBackupsRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	for _, route := range []string{"/api/backups/chat/delete", "/api/backups/chat/download"} {
		handler := map[string]func(http.ResponseWriter, *http.Request){
			"/api/backups/chat/delete":   accounts.serveBackupsChatDelete,
			"/api/backups/chat/download": accounts.serveBackupsChatDownload,
		}[route]
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
}

// backupsResolveChatPath reproduces the shared prelude of the two handlers and writes the pinned
// error itself when the request cannot produce a backup path.
func (runtime *accountRuntime) backupsResolveChatPath(w http.ResponseWriter, request *http.Request, directories map[string]string) (string, string, bool) {
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return "", "", false
	}
	nameNode := sdBodyMember(body, "name")
	name, isString := nameNode.stringValue()
	if !isString {
		// sanitize(undefined) throws in pinned and the route's own catch answers 500.
		backendsStatus(w, http.StatusInternalServerError)
		return "", "", false
	}
	sanitized := startup.SanitizeUserFilename(name)
	filePath := filepath.Join(directories["backups"], sanitized)
	if !strings.HasPrefix(filepath.Base(filePath), backupsChatPrefix) {
		backendsStatus(w, http.StatusBadRequest)
		return "", "", false
	}
	return sanitized, filePath, true
}

// serveBackupsChatDelete is backups.js:32.
func (runtime *accountRuntime) serveBackupsChatDelete(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	sanitized, filePath, ok := runtime.backupsResolveChatPath(w, request, directories)
	if !ok {
		return
	}
	if _, err := os.Stat(filePath); err != nil {
		backendsStatus(w, http.StatusNotFound)
		return
	}
	found, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), "backups/"+sanitized)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !found {
		backendsStatus(w, http.StatusNotFound)
		return
	}
	backendsStatus(w, http.StatusOK)
}

// serveBackupsChatDownload is backups.js:54: res.download(filePath).
//
// PINNED CONTRACT: res.download -> res.sendFile -> send@0.19.0 with acceptRanges/cacheControl/etag/
// lastModified and maxAge 0. The recorded fixture carries send's STAT etag for a 42-byte file with mtime
// 1700000000: W/"2a-18bcfe56800" (hex size - hex mtime MILLISECONDS). This route previously hand-wrote a
// CONTENT-hash ETag and no Last-Modified/Accept-Ranges/Cache-Control, so its ETag could never revalidate
// against pinned's and a download manager could not resume; the generic replay comparator only asserted
// that an ETag was present, which is why it stayed green. It now goes through the shared pinned-send
// implementation the static routes already use (sendPinnedFrontendStaticBytes), which reproduces the stat
// ETag, Last-Modified, Accept-Ranges, Cache-Control and the Range/206 behaviour; Express's req.fresh is
// false for a POST, and httpx.IsFresh refuses POST too, so this route still never answers 304.
func (runtime *accountRuntime) serveBackupsChatDownload(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	_, filePath, ok := runtime.backupsResolveChatPath(w, request, directories)
	if !ok {
		return
	}
	info, err := os.Stat(filePath)
	if err != nil || info.IsDir() {
		backendsStatus(w, http.StatusNotFound)
		return
	}
	name := filepath.Base(filePath)
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	sendPinnedFrontendStaticBytes(w, request, name, frontendStaticFile{
		size:       info.Size(),
		open:       func() (io.ReadSeekCloser, error) { return os.Open(filePath) },
		read:       func() ([]byte, error) { return os.ReadFile(filePath) },
		modTime:    info.ModTime(),
		hasModTime: true,
	})
}
