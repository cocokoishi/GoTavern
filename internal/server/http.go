// Package server contains the HTTP behavior implemented against the pinned
// SillyTavern reference. It deliberately exposes only routes with an oracle
// capture; the rest of the API remains unimplemented.
package server

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
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

// NewHTTPHandler serves the pinned frontend, callback redirect, version
// response, and seeded 404 page captured in the fresh-start Node oracle.
// Authentication and the remaining API routes are not part of this handler.
func NewHTTPHandler() http.Handler {
	page, err := upstream.Assets.ReadFile("default/content/errors/url-not-found.html")
	if err != nil {
		page = nil
	}
	return newHTTPHandler(page)
}

// NewHTTPHandlerWithDataRoot reads the final 404 page once when the handler is
// constructed, matching server-main's apply404Middleware startup behavior.
func NewHTTPHandlerWithDataRoot(dataRoot string) http.Handler {
	var page []byte
	if dataRoot != "" {
		page, _ = os.ReadFile(filepath.Join(dataRoot, "_errors", "url-not-found.html"))
	}
	return newHTTPHandler(page)
}

func newHTTPHandler(notFoundPage []byte) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /version", serveVersion)
	mux.HandleFunc("GET /callback", func(w http.ResponseWriter, r *http.Request) {
		serveCallback(w, r, notFoundPage)
	})
	mux.HandleFunc("GET /callback/", func(w http.ResponseWriter, r *http.Request) {
		serveCallback(w, r, notFoundPage)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		serveStatic(w, r, notFoundPage)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setPinnedSecurityHeaders(w.Header())
		mux.ServeHTTP(w, r)
	})
}

func setPinnedSecurityHeaders(header http.Header) {
	header.Set("Cross-Origin-Opener-Policy", "same-origin")
	header.Set("Cross-Origin-Resource-Policy", "same-origin")
	header.Set("Origin-Agent-Cluster", "?1")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-DNS-Prefetch-Control", "off")
	header.Set("X-Download-Options", "noopen")
	header.Set("X-Frame-Options", "SAMEORIGIN")
	header.Set("X-Permitted-Cross-Domain-Policies", "none")
	header.Set("X-XSS-Protection", "0")
	header.Set("Vary", "Origin, Accept-Encoding")
}

func serveCallback(w http.ResponseWriter, r *http.Request, notFoundPage []byte) {
	escapedPath := r.URL.EscapedPath()
	var source string
	switch {
	case escapedPath == "/callback" || escapedPath == "/callback/":
	case strings.HasPrefix(escapedPath, "/callback/"):
		rawSource := strings.TrimPrefix(escapedPath, "/callback/")
		if rawSource == "" || strings.Contains(rawSource, "/") {
			serveNotFound(w, r, notFoundPage)
			return
		}
		decoded, err := url.PathUnescape(rawSource)
		if err != nil {
			serveNotFound(w, r, notFoundPage)
			return
		}
		source = decoded
	default:
		serveNotFound(w, r, notFoundPage)
		return
	}

	params := make([]string, 0, 2)
	if source != "" {
		params = append(params, "source="+urlSearchParamEscape(source))
	}
	if r.URL.RawQuery != "" {
		params = append(params, "query="+urlSearchParamEscape(r.URL.RawQuery))
	}
	location := "/?" + strings.Join(params, "&")
	message := "Temporary Redirect. Redirecting to " + location
	contentType := "text/plain; charset=utf-8"
	body := message
	if acceptsHTMLRedirect(r.Header.Get("Accept")) {
		contentType = "text/html; charset=utf-8"
		body = "<p>" + html.EscapeString(message) + "</p>"
	}
	w.Header().Set("Location", location)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.Header().Set("Vary", "Origin, Accept, Accept-Encoding")
	w.WriteHeader(http.StatusTemporaryRedirect)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(body))
	}
}

func urlSearchParamEscape(value string) string {
	encoded := url.QueryEscape(value)
	encoded = strings.ReplaceAll(encoded, "~", "%7E")
	return strings.ReplaceAll(encoded, "%2A", "*")
}

func acceptsHTMLRedirect(accept string) bool {
	for _, mediaRange := range strings.Split(accept, ",") {
		mediaType, parameters, err := mime.ParseMediaType(strings.TrimSpace(mediaRange))
		if err != nil || mediaType != "text/html" {
			continue
		}
		quality := 1.0
		if value, ok := parameters["q"]; ok {
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil {
				quality = 0
			} else {
				quality = parsed
			}
		}
		return quality > 0
	}
	return false
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

func serveStatic(w http.ResponseWriter, r *http.Request, notFoundPage []byte) {
	assetPath := strings.TrimPrefix(r.URL.Path, "/")
	if assetPath == "" {
		assetPath = "index.html"
	}
	assetPath = path.Clean(assetPath)
	if assetPath == "." || assetPath == ".." || strings.HasPrefix(assetPath, "../") || strings.HasPrefix(assetPath, "/") {
		serveNotFound(w, r, notFoundPage)
		return
	}

	root := "public"
	if assetPath == "lib.js" {
		root = "generated"
	} else if !fsPathIsValid(assetPath) {
		serveNotFound(w, r, notFoundPage)
		return
	}

	body, err := upstream.Assets.ReadFile(root + "/" + assetPath)
	if err != nil {
		serveNotFound(w, r, notFoundPage)
		return
	}
	w.Header().Set("Content-Type", staticContentType(assetPath))
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func serveNotFound(w http.ResponseWriter, r *http.Request, page []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(page)))
	w.Header().Set("ETag", expressWeakETag(page))
	w.WriteHeader(http.StatusNotFound)
	if r.Method != http.MethodHead {
		_, _ = w.Write(page)
	}
}

func expressWeakETag(body []byte) string {
	digest := sha1.Sum(body)
	encoded := base64.StdEncoding.EncodeToString(digest[:])
	return fmt.Sprintf("W/\"%x-%s\"", len(body), encoded[:27])
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
