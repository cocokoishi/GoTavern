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
	"net/http"
	"os"
	"path/filepath"

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
