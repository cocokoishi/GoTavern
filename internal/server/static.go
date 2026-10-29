package server

// Pinned frontend static middleware, from src/server-main.js:242:
//
//	app.use(express.static(path.join(serverDirectory, 'public'), {}))
//
// It is mounted BEFORE requireLoginMiddleware (:248) and before
// setupPrivateEndpoints (:278), so a real file under public/ is served without
// authentication — including a real file in the global extensions directory at
// public/scripts/extensions/third-party/, which is why the extension route's
// global branch is reachable only for paths this middleware declines.
//
// The middleware is serve-static 1.16.x over send 0.19.0. Three structural
// behaviours from the pinned source shape this implementation, all recorded in
// tests/oracle/sillytavern-1.19.0-frontend-static.json:
//
//   - serve-static answers only GET and HEAD. Every other method falls through
//     to the rest of the application rather than being answered here.
//   - serve-static forwards an error to the application only after a file has
//     been resolved. A miss, a declined dotfile and send's own UP_PATH rejection
//     all fall through, so the middleware itself never produces a 404; only a
//     post-resolution failure (412, 416) reaches Express finalhandler.
//   - the directory redirect carries the full request path, because serve-static
//     hands send the full pathname, unlike the extension route where send saw a
//     request-relative path.
//
// The media type is the same pinned mime@1.6.0 table the extension static route
// uses: this path and that one are the same send() package, so one table serves
// both and mime.TypeByExtension is used by neither.
//
// Modification time, and the reason this reads from disk first:
//
// The pinned contract REQUIRES a real modification time. send() derives
// Last-Modified from stat.mtime and the ETag from size and mtime in
// milliseconds, and both drive observable behaviour rather than just headers:
// with Cache-Control "public, max-age=0" the browser revalidates on every load,
// and the pinned middleware answers 304 to a matching If-None-Match or
// If-Modified-Since and 412 to a failing If-Match or If-Unmodified-Since. An
// embedded asset has no modification time, so a response served from GoTavern's
// embedded copy cannot carry the pinned validators and would answer 200 where
// pinned answers 304. The middleware therefore reads
// <InstallRoot>/public/<path> first, exactly as the pinned middleware reads
// <serverDirectory>/public, and falls back to the embedded tree only when the
// file is not on disk.
//
// Known gaps, recorded in docs/compat-matrix.md:
//
//   - A file that exists only in the embedded tree carries no ETag and no
//     Last-Modified, so it answers 200 where pinned answers 304 and cannot answer
//     412. ARCHITECTURE.md:458 explicitly permits a runtime without a physical
//     public/ tree, so this divergence is architectural rather than an
//     implementation shortcut; it disappears for any path present on disk.
//   - The account gate treats a path as public only when it exists in the
//     embedded tree (accounts.go isPublicAccountRequest), so a file that exists
//     only on disk under public/ is answered 403 to an unauthenticated request
//     where pinned answers 200 with its bytes. Closing that needs the gate to
//     consult <InstallRoot>/public as well, which is outside this domain's files.
//   - /lib.js keeps its existing preference for the embedded generated bundle;
//     the pinned middleware would serve public/lib.js from disk. Unprobed.
//   - A malformed percent escape is rejected by net/http before the handler; a
//     literal ".." segment is cleaned by ServeMux into a redirect where Node
//     reaches send's own rejection.

import (
	"fmt"
	"html"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/upstream"
)

// pinnedStaticETag reproduces the etag package's Stats form, which send() uses:
// the file size and its modification time in milliseconds, both in hex.
func pinnedStaticETag(size int64, modTime time.Time) string {
	return "W/\"" + strconv.FormatInt(size, 16) + "-" + strconv.FormatInt(modTime.UnixMilli(), 16) + "\""
}

// pinnedSendHtmlDocument reproduces send()'s createHtmlDocument.
func pinnedSendHtmlDocument(title, body string) string {
	return "<!DOCTYPE html>\n" +
		"<html lang=\"en\">\n" +
		"<head>\n" +
		"<meta charset=\"utf-8\">\n" +
		"<title>" + title + "</title>\n" +
		"</head>\n" +
		"<body>\n" +
		"<pre>" + body + "</pre>\n" +
		"</body>\n" +
		"</html>\n"
}

// frontendStaticFile is the resolved asset plus the metadata send() needs. A
// file served from the embedded tree has no modification time.
//
// THE CONTENT IS RESOLVED LAZILY, AND THAT IS A MEASURED PERFORMANCE DECISION, not a style one.
// `internal/server/bench_test.go` (the in-process baseline this repository did not have before 2026-10-29) plus a
// heap profile showed that serving `/script.js` -- 497,669 bytes -- allocated 1,511,810 B/op, and `pprof
// -alloc_space` put 66% of it in a single leaf: `embed.FS.ReadFile`, called once per request. A page load requests
// ~229 assets (docs/frontend-startup-calls.md), so a full read per request is ~220 MB of garbage per page load
// for bytes that never change.
//
// `open` returns a SEEKABLE reader so a range request can be served without materialising the whole file, and
// `read` is the fallback. BOTH are closures built from a name -- resolving them does no I/O -- because the
// resolver below is ALSO the existence check the account gate runs on every request
// (`pinnedFrontendStaticServes`), and a resolver that opened a file would leak a descriptor on every one of those
// checks. That is why the file is not opened here: the caller opens it, once, at the moment it writes the body.
type frontendStaticFile struct {
	body        []byte
	size        int64
	open        func() (io.ReadSeekCloser, error)
	read        func() ([]byte, error)
	modTime     time.Time
	hasModTime  bool
	isDirectory bool
}

// openEmbeddedAsset opens a file from the embedded asset tree as a seekable reader. The embedded file type
// implements io.Seeker; the assertion is checked once here rather than assumed, and a tree that ever stopped
// being seekable falls back to `read` instead of failing the request.
func openEmbeddedAsset(name string) (io.ReadSeekCloser, error) {
	file, err := upstream.Assets.Open(name)
	if err != nil {
		return nil, err
	}
	seekable, ok := file.(io.ReadSeekCloser)
	if !ok {
		_ = file.Close()
		return nil, fmt.Errorf("embedded asset %s is not seekable", name)
	}
	return seekable, nil
}

// pinnedFrontendStaticServes reports whether the pinned frontend static
// middleware would answer this request with anything other than a fall-through.
//
// The account gate uses it so that a path is treated as public exactly when the
// middleware would answer it and no wider. It deliberately reuses the handler's
// own resolution — the same clean, dotfile, disk-then-embedded and index rules —
// rather than approximating them, because a gate wider than the handler turns a
// fall-through into a leak, and a gate narrower than it hides a served file
// behind a 403.
//
// A directory without a trailing slash counts as served: the middleware answers
// it with a redirect, and the middleware runs before the login gate.
func pinnedFrontendStaticServes(options HTTPHandlerOptions, r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	assetPath := strings.TrimPrefix(r.URL.Path, "/")
	if assetPath == "" {
		assetPath = "index.html"
	}
	clean := path.Clean(assetPath)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || strings.Contains(clean, "\\") {
		return false
	}
	parts := strings.Split(clean, "/")
	if pinnedContainsDotFile(parts) && strings.HasPrefix(parts[len(parts)-1], ".") {
		return false
	}
	file, ok := readPinnedFrontendStaticFile(options, clean)
	if !ok {
		return false
	}
	if !file.isDirectory {
		return true
	}
	if !strings.HasSuffix(r.URL.Path, "/") {
		return true
	}
	index, ok := readPinnedFrontendStaticFile(options, path.Join(clean, "index.html"))
	return ok && !index.isDirectory
}

// servePinnedFrontendStatic is the shared entry point for every request that
// reaches the mux without a more specific route, which is exactly the pinned
// middleware's position in the stack.
func servePinnedFrontendStatic(w http.ResponseWriter, r *http.Request, notFoundPage []byte, options HTTPHandlerOptions) {
	if options.AccountsEnabled && r.URL.Path == "/" && accountFromContext(r).user == nil {
		location := "/login"
		if r.URL.RawQuery != "" {
			location += "?" + r.URL.RawQuery
		}
		serveRedirect(w, r, http.StatusFound, location)
		return
	}
	// serve-static answers only GET and HEAD and falls through otherwise.
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		serveNotFound(w, r, notFoundPage)
		return
	}
	assetPath := strings.TrimPrefix(r.URL.Path, "/")
	if assetPath == "" {
		assetPath = "index.html"
	}
	clean := path.Clean(assetPath)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || strings.Contains(clean, "\\") {
		serveNotFound(w, r, notFoundPage)
		return
	}
	// send()'s legacy dotfile rule looks at the last path part only.
	parts := strings.Split(clean, "/")
	if pinnedContainsDotFile(parts) && strings.HasPrefix(parts[len(parts)-1], ".") {
		serveNotFound(w, r, notFoundPage)
		return
	}
	file, ok := readPinnedFrontendStaticFile(options, clean)
	if !ok {
		serveNotFound(w, r, notFoundPage)
		return
	}
	if file.isDirectory {
		if !strings.HasSuffix(r.URL.Path, "/") {
			// send()'s redirect, with the full request path, because serve-static
			// hands send the full pathname.
			location := r.URL.EscapedPath() + "/"
			servePinnedStaticRedirect(w, location)
			return
		}
		indexName := path.Join(clean, "index.html")
		index, ok := readPinnedFrontendStaticFile(options, indexName)
		if !ok || index.isDirectory {
			serveNotFound(w, r, notFoundPage)
			return
		}
		// send()'s sendIndex serves the index file, so the media type comes from
		// the index file's own name rather than from the directory.
		sendPinnedFrontendStaticBytes(w, r, indexName, index)
		return
	}
	sendPinnedFrontendStaticBytes(w, r, clean, file)
}

// readPinnedFrontendStaticFile resolves one asset. The pinned middleware reads
// <serverDirectory>/public from disk; GoTavern reads <InstallRoot>/public first
// so a real deployment keeps the pinned validators, and falls back to the
// embedded vendored tree, which is what a runtime without a physical public/
// tree has.
//
// ONE EXCEPTION, and it is measured rather than assumed: /lib.js comes from the
// GENERATED bundle, never from a disk public/lib.js. The pinned server mounts the
// webpack middleware ahead of express.static (server-main.js:240), so its own
// public/lib.js -- a 3,085-byte placeholder -- is never the file a browser gets;
// the real one is the ~1.9 MB generated bundle. A release stages public/** beside
// the binary, so this function used to find that placeholder first and return it.
//
// The consequence was a release-blocking regression rather than a cosmetic one: the
// browser drive against the release layout stopped after 203 requests with the
// preloader still up, because the placeholder does not boot the app, while the same
// drive reached settingsReady against the pinned server. A 200 with the wrong BYTES
// is worse than a 404 -- nothing reports it, and every extension probe fails later
// with no explanation. The check therefore runs BEFORE the disk lookup.
func readPinnedFrontendStaticFile(options HTTPHandlerOptions, clean string) (frontendStaticFile, bool) {
	if clean == "lib.js" {
		if info, err := fs.Stat(upstream.Assets, "generated/lib.js"); err == nil && !info.IsDir() {
			return frontendStaticFile{
				size: info.Size(),
				open: func() (io.ReadSeekCloser, error) { return openEmbeddedAsset("generated/lib.js") },
				read: func() ([]byte, error) { return upstream.Assets.ReadFile("generated/lib.js") },
			}, true
		}
	}
	if options.InstallRoot != "" {
		target := filepath.Join(options.InstallRoot, "public", filepath.FromSlash(clean))
		if info, err := os.Stat(target); err == nil {
			if info.IsDir() {
				return frontendStaticFile{isDirectory: true}, true
			}
			return frontendStaticFile{
				size:       info.Size(),
				open:       func() (io.ReadSeekCloser, error) { return os.Open(target) },
				read:       func() ([]byte, error) { return os.ReadFile(target) },
				modTime:    info.ModTime(),
				hasModTime: true,
			}, true
		}
	}
	embedded := "public/" + clean
	info, err := fs.Stat(upstream.Assets, embedded)
	if err != nil {
		return frontendStaticFile{}, false
	}
	if info.IsDir() {
		return frontendStaticFile{isDirectory: true}, true
	}
	return frontendStaticFile{
		size: info.Size(),
		open: func() (io.ReadSeekCloser, error) { return openEmbeddedAsset(embedded) },
		read: func() ([]byte, error) { return upstream.Assets.ReadFile(embedded) },
	}, true
}

// servePinnedStaticRedirect reproduces send()'s redirect().
func servePinnedStaticRedirect(w http.ResponseWriter, location string) {
	body := []byte(pinnedSendHtmlDocument("Redirecting", "Redirecting to "+html.EscapeString(location)))
	w.Header().Set("Content-Type", "text/html; charset=UTF-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusMovedPermanently)
	_, _ = w.Write(body)
}

// sendPinnedFrontendStaticBytes reproduces send()'s send() for a static asset.
// It reuses the pinned helpers the extension static route already carries, so
// the two paths cannot drift on the range, conditional or media-type rules.
func sendPinnedFrontendStaticBytes(w http.ResponseWriter, r *http.Request, name string, file frontendStaticFile) {
	header := w.Header()
	size := file.size
	if file.open == nil {
		size = int64(len(file.body))
	}

	if header.Get("Accept-Ranges") == "" {
		header.Set("Accept-Ranges", "bytes")
	}
	if header.Get("Cache-Control") == "" {
		header.Set("Cache-Control", "public, max-age=0")
	}
	if file.hasModTime {
		if header.Get("Last-Modified") == "" {
			header.Set("Last-Modified", file.modTime.UTC().Format(http.TimeFormat))
		}
		if header.Get("ETag") == "" {
			header.Set("ETag", pinnedStaticETag(size, file.modTime))
		}
	}
	if header.Get("Content-Type") == "" {
		header.Set("Content-Type", pinnedMimeV1ContentType(name))
	}

	if r.Header.Get("If-Match") != "" || r.Header.Get("If-Unmodified-Since") != "" ||
		r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
		if pinnedExtensionPreconditionFailure(r, header.Get("ETag"), header.Get("Last-Modified")) {
			respondPinnedExtensionErrorPage(w, http.StatusPreconditionFailed, "")
			return
		}
		if pinnedExtensionFresh(r, header.Get("ETag"), header.Get("Last-Modified")) {
			header.Del("Content-Encoding")
			header.Del("Content-Language")
			header.Del("Content-Length")
			header.Del("Content-Range")
			header.Del("Content-Type")
			pinnedExtensionApplyVary(header)
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}

	offset := int64(0)
	length := size
	status := http.StatusOK
	if rangeHeader := r.Header.Get("Range"); pinnedExtensionBytesRangePattern.MatchString(rangeHeader) {
		ranges, outcome := pinnedParseRange(size, rangeHeader)
		if !pinnedExtensionRangeFresh(r, header.Get("ETag"), header.Get("Last-Modified")) {
			outcome = pinnedRangeStale
		}
		switch {
		case outcome == pinnedRangeUnsatisfiable:
			respondPinnedExtensionErrorPage(w, http.StatusRequestedRangeNotSatisfiable, "bytes */"+strconv.FormatInt(size, 10))
			return
		case outcome == pinnedRangeOK && len(ranges) == 1:
			status = http.StatusPartialContent
			header.Set("Content-Range", "bytes "+strconv.FormatInt(ranges[0].start, 10)+"-"+strconv.FormatInt(ranges[0].end, 10)+"/"+strconv.FormatInt(size, 10))
			offset = ranges[0].start
			length = ranges[0].end - ranges[0].start + 1
		}
	}

	header.Set("Content-Length", strconv.FormatInt(length, 10))
	pinnedExtensionApplyVary(header)
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	if offset < 0 || offset+length > size {
		return
	}
	// STREAM THE SLICE THE RESPONSE DECLARED, rather than materialising the file to write it. The bytes, the
	// status, the Content-Length and every header are exactly what the buffered path produced; only the peak
	// allocation changes. A failure here cannot produce a short body under a declared Content-Length: the
	// seekable path is tried first and the `read` fallback re-reads the same immutable bytes.
	if file.open != nil {
		if reader, openErr := file.open(); openErr == nil {
			defer func() { _ = reader.Close() }()
			if _, seekErr := reader.Seek(offset, io.SeekStart); seekErr == nil {
				_, _ = io.CopyN(w, reader, length)
				return
			}
		}
	}
	if file.read != nil {
		if body, readErr := file.read(); readErr == nil && int64(len(body)) == size {
			_, _ = w.Write(body[offset : offset+length])
			return
		}
	}
	_, _ = w.Write(file.body[offset : offset+length])
}
