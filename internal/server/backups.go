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
// DEFERRED, recorded in the fixture knownDifferences: /api/backups/chat/get (needs the getChatInfo
// port: stat, formatBytes, first message and chat_items counting).

import (
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const backupsChatPrefix = "chat_"

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerBackupsRoutes)
}

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
	data, err := os.ReadFile(filePath)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(filePath)))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filepath.Base(filePath)+"\"")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("ETag", expressWeakETag(data))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
