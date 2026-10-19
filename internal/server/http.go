// Package server contains the HTTP behavior implemented against the pinned
// SillyTavern reference. It deliberately exposes only routes with an oracle
// capture; the rest of the API remains unimplemented.
package server

import (
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/cocokoishi/gotavern/upstream"
)

const (
	upstreamAgent      = "SillyTavern:1.19.0:Cohee#1207"
	upstreamRevision   = "06bde939f"
	upstreamBranch     = "release"
	upstreamCommitDate = "2026-09-14 21:01:34 +0200"
)

type versionResponse struct {
	Agent       string `json:"agent"`
	PkgVersion  string `json:"pkgVersion"`
	GitRevision string `json:"gitRevision"`
	GitBranch   string `json:"gitBranch"`
	CommitDate  string `json:"commitDate"`
	IsLatest    bool   `json:"isLatest"`
}

// NewHTTPHandler serves the pinned frontend and version response captured in
// the fresh-start Node oracle. Startup, authentication, and API routes are not
// part of this handler yet.
func NewHTTPHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /version", serveVersion)
	mux.HandleFunc("GET /", serveStatic)
	return mux
}

func serveVersion(w http.ResponseWriter, r *http.Request) {
	body, err := json.Marshal(versionResponse{
		Agent:       upstreamAgent,
		PkgVersion:  upstream.SillyTavernVersion,
		GitRevision: upstreamRevision,
		GitBranch:   upstreamBranch,
		CommitDate:  upstreamCommitDate,
		IsLatest:    true,
	})
	if err != nil {
		http.Error(w, "version response unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func serveStatic(w http.ResponseWriter, r *http.Request) {
	assetPath := strings.TrimPrefix(r.URL.Path, "/")
	if assetPath == "" {
		assetPath = "index.html"
	}
	assetPath = path.Clean(assetPath)
	if assetPath == "." || assetPath == ".." || strings.HasPrefix(assetPath, "../") || strings.HasPrefix(assetPath, "/") {
		http.NotFound(w, r)
		return
	}

	root := "public"
	if assetPath == "lib.js" {
		root = "generated"
	} else if !fsPathIsValid(assetPath) {
		http.NotFound(w, r)
		return
	}

	body, err := upstream.Assets.ReadFile(root + "/" + assetPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", staticContentType(assetPath))
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func fsPathIsValid(p string) bool {
	return p != "" && p != "." && !strings.HasPrefix(p, "../") && !strings.HasPrefix(p, "/")
}

func staticContentType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".html", ".htm":
		return "text/html; charset=UTF-8"
	case ".js", ".mjs":
		return "application/javascript; charset=UTF-8"
	case ".css":
		return "text/css; charset=UTF-8"
	case ".json":
		return "application/json; charset=utf-8"
	default:
		if contentType := mime.TypeByExtension(path.Ext(name)); contentType != "" {
			return contentType
		}
		return "application/octet-stream"
	}
}
