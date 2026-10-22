package server

// Pinned chat-backup LISTING route, from src/endpoints/backups.js:9:
//
//	POST /api/backups/chat/get
//
// The handler enumerates the user's `backups` directory, keeps the entries that are FILES whose
// extension is exactly `.jsonl` and whose name starts with CHAT_BACKUPS_PREFIX ("chat_"), builds one
// `getChatInfo` record per file and answers `res.json(array)`.
//
// `getChatInfo` is the SHARED helper from src/endpoints/chats.js:393, and the default-argument call
// this route makes (`getChatInfo(filePath)` -> no additional data, no metadata, no matcher) is
// EXACTLY the shape internal/server/chats_search_recent.go already ports as `pinnedChatInfo`. A third
// copy would be a fork of the same contract with a separate mutation surface, so this file calls the
// existing port with the pinned call's defaults instead:
//
//	additionalData = nil      (the pinned default `{}` contributes nothing under the spread)
//	withMetadata   = false
//	matcher        = nil
//
// The chats-local `getChatInfo` in characters_read.go is NOT interchangeable: it has no additional
// data and no matcher, so it cannot serve the search/recents call sites, and it collapses every
// stat error into the vanished-file object instead of re-throwing a non-ENOENT error the way the
// pinned helper does. `pinnedChatInfo` reproduces both.
//
// Evidence: tools/probe-backups-chat-get.mjs records tests/oracle/sillytavern-1.19.0-backups-chat-get.json
// from the pinned server with node-fetch AND the global fetch replaced, so every step asserts ZERO
// outbound requests; internal/server/backups_chat_get_test.go replays the ordered steps.
//
// HOST-DEPENDENCE: the pinned response is built in readdir order, which differs between NTFS and
// ext4, so the fixture records the listing sorted by file_name and the replay sorts its own answer
// the same way; the raw-byte ETag is consequently classified `shape` and records no value. Every
// seeded file carries a fixed whole-second mtime, so `last_mes` is a constant.

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerBackupsChatGetRoutes)
}

func registerBackupsChatGetRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/backups/chat/get", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveBackupsChatGet(w, r)
	})
}

// backupsEntryIsFile is `dirent.isFile()`: a regular file, so a DIRECTORY named like a backup and a
// symlink are both excluded.
func backupsEntryIsFile(entry os.DirEntry) bool {
	return entry.Type().IsRegular()
}

// serveBackupsChatGet is backups.js:9.
func (runtime *accountRuntime) serveBackupsChatGet(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	entries, err := os.ReadDir(directories["backups"])
	if err != nil {
		// `fsPromises.readdir` rejects for a missing or unreadable directory and the route's own
		// catch answers sendStatus(500); zero outbound requests are attempted either way.
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	backupModels := make([]orderedNodeJSON, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !backupsEntryIsFile(entry) {
			continue
		}
		if nodePathExt(name) != ".jsonl" {
			continue
		}
		if !strings.HasPrefix(name, backupsChatPrefix) {
			continue
		}
		info, infoErr := pinnedChatInfo(filepath.Join(directories["backups"], name), nil, false, nil)
		if infoErr != nil {
			backendsStatus(w, http.StatusInternalServerError)
			return
		}
		// `if (!info || !info.file_name) continue;` — the vanished-file object has no file_name.
		if !jsTruthy(nodeGet(info, "file_name")) {
			continue
		}
		backupModels = append(backupModels, info)
	}
	respondOrderedNodeJSON(w, http.StatusOK, nodeArray(backupModels...))
}
