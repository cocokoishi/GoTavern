package server

// Pinned stats read route, from src/endpoints/stats.js:444:
//
//	POST /api/stats/get -> STATS.get(request.user.profile.handle) || {}
//
// The pinned server keeps a per-user in-memory copy loaded from `<user>/stats.json` at startup and
// answers the stored object, falling back to `{}` when the user has no stats entry. This route
// reads the same file and applies the same fallback. It does NOT implement the in-memory cache or
// the write/recreate routes: those are separate pinned behaviours with their own observables, and
// this route exists because the frontend calls it while building the chat view for a send.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerStatsRoutes)
}

func registerStatsRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/stats/get", accounts.serveStatsGet)
	post("/api/stats/update", accounts.serveStatsUpdate)
	post("/api/stats/recreate", accounts.serveStatsRecreate)
	registerStatsAliases(mux)
}

// serveStatsGet answers the user's stats object, or `{}` when the user has none.
func (runtime *accountRuntime) serveStatsGet(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	body, err := readStatsFile(directories)
	if err != nil || len(body) == 0 {
		// The pinned handler answers {} when there is no entry for the handle.
		respondJSONBytes(w, http.StatusOK, []byte("{}"))
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// readStatsFile returns the raw stats.json body, preserving its key order, or nil when absent.
func readStatsFile(directories startup.UserDirectories) ([]byte, error) {
	root := directories["root"]
	if root == "" {
		return nil, os.ErrNotExist
	}
	body, err := os.ReadFile(filepath.Join(root, "stats.json"))
	if err != nil {
		return nil, err
	}
	return body, nil
}

// serveStatsUpdate reproduces POST /api/stats/update (stats.js:465): a body is required, the stored
// object is replaced with it plus a fresh `timestamp`, and the route answers 200 with no content.
//
// Note on ordering: the pinned code sets `stats.timestamp` on the parsed object and persists it, so
// its key order is the body's order with `timestamp` inserted where it already was. This writes the
// object through a Go map, so key ORDER is not preserved (values are). That is recorded as a gap for
// the storage-parity increment rather than silently accepted.
func (runtime *accountRuntime) serveStatsUpdate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	body, bodyOK := tokenizerRawBody(request)
	if !bodyOK || len(body) == 0 || string(body) == "null" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	var stats map[string]any
	if err := json.Unmarshal(body, &stats); err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	stats["timestamp"] = time.Now().UnixMilli()
	encoded, err := json.Marshal(stats)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	root := directories["root"]
	if root == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := startup.WriteFileAtomic(filepath.Join(root, "stats.json"), encoded); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}

// serveStatsRecreate reproduces POST /api/stats/recreate (stats.js:452): the requesting user's
// statistics are recalculated from the chat files, persisted, then the route answers 200 with
// Express's sendStatus body. A failure answers 500 with the same body shape. It recomputes even
// when a valid stats.json already exists, which is what separates it from the startup path.
func (runtime *accountRuntime) serveStatsRecreate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	if _, err := startup.RecreateUserStatistics(directories, time.Now()); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}

// Deprecated stats aliases, from redirectDeprecatedEndpoints (server-startup.js:114-116): they are
// HTTP redirects to the canonical routes, not second handlers, so one implementation serves both.
func registerStatsAliases(mux *http.ServeMux) {
	redirects := map[string]string{
		"/getstats":      "/api/stats/get",
		"/updatestats":   "/api/stats/update",
		"/recreatestats": "/api/stats/recreate",
	}
	for source, destination := range redirects {
		destination := destination
		mux.HandleFunc(source, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, destination, http.StatusFound)
		})
	}
}
