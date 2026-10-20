package server

// Pinned extension static serving, from src/users.js:1219:
//
//	router.use('/scripts/extensions/third-party/*',
//	           extensionsEnabledFeatureGuard,
//	           createExtensionsRouteHandler(req => req.user.directories.extensions));
//
// createExtensionsRouteHandler (users.js:1092-1120) decodes the wildcard
// capture, joins it onto the requesting user's extensions directory, rejects a
// result that escapes that directory, serves the file when it exists, and
// otherwise repeats the same three steps against
// PUBLIC_DIRECTORIES.globalExtensions before answering sendStatus(404).
//
// The pinned response shape is not send()'s own: Express's res.sendFile attaches
// error, directory, file, stream and end listeners to the send stream, so
//   - a send error (declined dotfile, directory with no index, unsatisfiable or
//     malformed range, failed precondition) is emitted as an error and rendered
//     by Express finalhandler as a V8 stack page;
//   - a directory request without a trailing slash is turned into a plain next()
//     and lands on the application's final 404, so send()'s 301 redirect and its
//     own 403 for a ".." path are both unreachable through this route.
// Those responses are compared by status, content type and (for 416) Content-Range
// only, because finalhandler's page embeds host-absolute paths and pinned line
// numbers. GoTavern writes send's own minimal error document instead.
//
// Two further pinned details this file reproduces deliberately:
//   - the route does NOT call invalidateFirefoxCache; that call exists only in
//     createRouteHandler (users.js:1079), so a Firefox user agent changes nothing
//     here;
//   - the media type comes from send@0.19.0's mime@1.6.0 dependency, whose lookup
//     falls back to application/octet-stream and whose charsets table appends
//     "; charset=UTF-8" for text/* and for application/javascript and
//     application/json. mime.TypeByExtension is never used here: it reads the
//     host MIME database.
//
// Known gaps, recorded in docs/compat-matrix.md:
//
//   - A real file in the global extensions directory is served by the frontend
//     static middleware (server-main.js:242 express.static(serverDirectory/public),
//     mounted before requireLoginMiddleware at :248 and before
//     setupPrivateEndpoints at :278), because the URL space maps one-to-one onto
//     <serverDirectory>/public/scripts/extensions/third-party. That middleware
//     answers before this route and before authentication, so this route's global
//     branch is reachable only for paths express.static declines; per-user
//     precedence over an existing global file is therefore not observable through
//     this route, and GoTavern's own frontend static handling owns that contract.
//   - A malformed percent escape is rejected by net/http before the handler while
//     Node passes it to the route, which answers 500; a literal ".." segment is
//     cleaned by net/http's ServeMux into a redirect while Node passes it to the
//     route, which answers the route's plain-text 403.
//   - send()'s If-Range handling and its multi-range combining are implemented
//     but unprobed, and unusual percent-encoding inside a filename is not probed.

import (
	"fmt"
	"html"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerExtensionStaticRoutes)
}

func registerExtensionStaticRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	// router.use matches every method, so this pattern deliberately has none.
	// The pattern needs the trailing slash, exactly like the pinned mount: the
	// bare /scripts/extensions/third-party maps onto the existing global
	// directory and is handled by the frontend static middleware instead.
	mux.HandleFunc("/scripts/extensions/third-party/{rest...}", func(w http.ResponseWriter, r *http.Request) {
		accounts.serveExtensionStatic(w, r, notFoundPage)
	})
}

func (runtime *accountRuntime) serveExtensionStatic(w http.ResponseWriter, r *http.Request, notFoundPage []byte) {
	// The pinned frontend static middleware is mounted at server-main.js:242,
	// before the private routers at :278, so it answers first for anything under
	// public/ — including a real file in the global extensions directory. Only
	// when it would fall through does this route run. Without this the mux would
	// route that URL space here and answer 403 to an unauthenticated request
	// where pinned answers 200 with the file's bytes.
	if pinnedFrontendStaticServes(runtime.options, r) {
		servePinnedFrontendStatic(w, r, notFoundPage, runtime.options)
		return
	}
	_, directories, ok := runtime.extensionAccount(w, r)
	if !ok {
		return
	}
	filePath := r.PathValue("rest")
	if servePinnedExtensionRoot(w, r, directories["extensions"], filePath, notFoundPage) {
		return
	}
	if servePinnedExtensionRoot(w, r, pinnedGlobalExtensionsDirectory(runtime.options), filePath, notFoundPage) {
		return
	}
	// The pinned route ends with res.sendStatus(404), which is text/plain.
	serveStatusText(w, http.StatusNotFound)
}

// servePinnedExtensionRoot reproduces one pass of the pinned handler over one
// root. It reports whether the request was answered; a miss moves on to the next
// root, exactly like the pinned existsSync check.
func servePinnedExtensionRoot(w http.ResponseWriter, r *http.Request, root, filePath string, notFoundPage []byte) bool {
	target := filepath.Join(root, filePath)
	if !nodeIsPathUnderParent(root, target) {
		// res.sendStatus(403), which is text/plain.
		serveStatusText(w, http.StatusForbidden)
		return true
	}
	if _, err := os.Stat(target); err != nil {
		return false
	}
	sendPinnedExtensionFile(w, r, target, filePath, notFoundPage)
	return true
}

// nodeIsPathUnderParent mirrors util.js:1407-1414.
func nodeIsPathUnderParent(parent, child string) bool {
	relative, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
	if err != nil {
		return false
	}
	if relative == ".." {
		return false
	}
	if strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false
	}
	return !filepath.IsAbs(relative)
}

// sendPinnedExtensionFile mirrors the part of send()'s pipe() that runs before
// the file is transferred, plus the two cases Express intercepts first.
func sendPinnedExtensionFile(w http.ResponseWriter, r *http.Request, target, filePath string, notFoundPage []byte) {
	// res.sendFile throws for an empty path and the route's catch answers 500.
	if filePath == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		respondPinnedExtensionErrorPage(w, http.StatusNotFound, "")
		return
	}
	// send()'s dotfile rule only looks at the last path part: a trailing dotfile
	// is declined, a dotfile in a middle segment is served.
	parts := strings.Split(filepath.Clean("."+string(filepath.Separator)+filePath), string(filepath.Separator))
	if pinnedContainsDotFile(parts) && strings.HasPrefix(parts[len(parts)-1], ".") {
		respondPinnedExtensionErrorPage(w, http.StatusNotFound, "")
		return
	}
	// send()'s index lookup runs before its file lookup, so a trailing slash
	// selects index.html whether the target is a directory or not.
	if strings.HasSuffix(filePath, "/") {
		indexPath := filepath.Join(target, "index.html")
		indexInfo, err := os.Stat(indexPath)
		if err != nil || indexInfo.IsDir() {
			respondPinnedExtensionErrorPage(w, http.StatusNotFound, "")
			return
		}
		sendPinnedExtensionBytes(w, r, indexPath, indexInfo)
		return
	}
	if info.IsDir() {
		// Express's sendfile attaches a directory listener that reports EISDIR, and
		// res.sendFile's callback answers EISDIR with next(), so the request falls
		// through to the application's final 404 rather than to send's redirect.
		serveNotFound(w, r, notFoundPage)
		return
	}
	sendPinnedExtensionBytes(w, r, target, info)
}

// pinnedContainsDotFile mirrors send()'s containsDotFile: a part counts only
// when it is longer than one character.
func pinnedContainsDotFile(parts []string) bool {
	for _, part := range parts {
		if len(part) > 1 && part[0] == '.' {
			return true
		}
	}
	return false
}

var pinnedExtensionNoCachePattern = regexp.MustCompile(`(?:^|,)\s*?no-cache\s*?(?:,|$)`)

var pinnedExtensionBytesRangePattern = regexp.MustCompile(`^ *bytes=`)

// sendPinnedExtensionBytes reproduces send()'s send() for one file.
func sendPinnedExtensionBytes(w http.ResponseWriter, r *http.Request, target string, info os.FileInfo) {
	size := info.Size()
	header := w.Header()

	// setHeader()
	if header.Get("Accept-Ranges") == "" {
		header.Set("Accept-Ranges", "bytes")
	}
	if header.Get("Cache-Control") == "" {
		header.Set("Cache-Control", "public, max-age=0")
	}
	if header.Get("Last-Modified") == "" {
		header.Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
	}
	if header.Get("ETag") == "" {
		header.Set("ETag", fmt.Sprintf("W/\"%x-%x\"", size, info.ModTime().UnixMilli()))
	}
	// type()
	if header.Get("Content-Type") == "" {
		header.Set("Content-Type", pinnedMimeV1ContentType(target))
	}

	// conditional GET
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
	contentRange := ""

	// Range support
	if rangeHeader := r.Header.Get("Range"); pinnedExtensionBytesRangePattern.MatchString(rangeHeader) {
		ranges, outcome := pinnedParseRange(size, rangeHeader)
		if !pinnedExtensionRangeFresh(r, header.Get("ETag"), header.Get("Last-Modified")) {
			outcome = pinnedRangeStale
		}
		switch {
		case outcome == pinnedRangeUnsatisfiable:
			// send() sets Content-Range on the response and then raises the 416, so
			// that header survives into the error page.
			contentRange = fmt.Sprintf("bytes */%d", size)
			respondPinnedExtensionErrorPage(w, http.StatusRequestedRangeNotSatisfiable, contentRange)
			return
		case outcome == pinnedRangeOK && len(ranges) == 1:
			status = http.StatusPartialContent
			contentRange = fmt.Sprintf("bytes %d-%d/%d", ranges[0].start, ranges[0].end, size)
			header.Set("Content-Range", contentRange)
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
	if status == http.StatusPartialContent {
		if _, err := w.Write(pinnedExtensionReadRange(target, offset, length)); err != nil {
			return
		}
		return
	}
	if body, err := os.ReadFile(target); err == nil {
		_, _ = w.Write(body)
	}
}

func pinnedExtensionReadRange(target string, offset, length int64) []byte {
	file, err := os.Open(target)
	if err != nil {
		return nil
	}
	defer file.Close()
	buffer := make([]byte, length)
	read, err := file.ReadAt(buffer, offset)
	if err != nil && read == 0 {
		return nil
	}
	return buffer[:read]
}

// pinnedExtensionApplyVary restores the pinned Vary value for a response whose
// content type the compression middleware does not consider compressible. The
// shared GoTavern middleware always sets both values, so a non-compressible
// response has to put the pinned one back.
func pinnedExtensionApplyVary(header http.Header) {
	if !pinnedCompressibleContentType(header.Get("Content-Type")) {
		header.Set("Vary", "Origin")
	}
}

// pinnedExtensionFresh mirrors the fresh package as send() uses it for the 304
// decision.
func pinnedExtensionFresh(r *http.Request, etag, lastModified string) bool {
	noneMatch := r.Header.Get("If-None-Match")
	modifiedSince := r.Header.Get("If-Modified-Since")
	if noneMatch == "" && modifiedSince == "" {
		return false
	}
	if pinnedExtensionNoCachePattern.MatchString(r.Header.Get("Cache-Control")) {
		return false
	}
	if noneMatch != "" && noneMatch != "*" {
		if etag == "" {
			return false
		}
		matched := false
		for _, candidate := range pinnedParseTokenList(noneMatch) {
			if candidate == etag || candidate == "W/"+etag || "W/"+candidate == etag {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	if modifiedSince != "" {
		if lastModified == "" {
			return false
		}
		modified, modifiedErr := http.ParseTime(lastModified)
		since, sinceErr := http.ParseTime(modifiedSince)
		if modifiedErr != nil || sinceErr != nil || modified.After(since) {
			return false
		}
	}
	return true
}

// pinnedExtensionPreconditionFailure mirrors send()'s isPreconditionFailure.
func pinnedExtensionPreconditionFailure(r *http.Request, etag, lastModified string) bool {
	if match := r.Header.Get("If-Match"); match != "" {
		if etag == "" {
			return true
		}
		if match != "*" {
			matched := false
			for _, candidate := range pinnedParseTokenList(match) {
				if candidate == etag || candidate == "W/"+etag || "W/"+candidate == etag {
					matched = true
					break
				}
			}
			if !matched {
				return true
			}
		}
		return false
	}
	if raw := r.Header.Get("If-Unmodified-Since"); raw != "" {
		if unmodifiedSince, err := http.ParseTime(raw); err == nil {
			modified, modifiedErr := http.ParseTime(lastModified)
			if modifiedErr != nil || modified.After(unmodifiedSince) {
				return true
			}
		}
	}
	return false
}

// pinnedExtensionRangeFresh mirrors send()'s isRangeFresh.
func pinnedExtensionRangeFresh(r *http.Request, etag, lastModified string) bool {
	ifRange := r.Header.Get("If-Range")
	if ifRange == "" {
		return true
	}
	if strings.Contains(ifRange, "\"") {
		return etag != "" && strings.Contains(ifRange, etag)
	}
	modified, modifiedErr := http.ParseTime(lastModified)
	requested, requestedErr := http.ParseTime(ifRange)
	if modifiedErr != nil || requestedErr != nil {
		return false
	}
	return !modified.After(requested)
}

// pinnedParseTokenList mirrors send()'s parseTokenList: split on commas, trimming
// spaces and tabs around each entry.
func pinnedParseTokenList(value string) []string {
	parts := strings.Split(value, ",")
	list := make([]string, 0, len(parts))
	for _, part := range parts {
		list = append(list, strings.Trim(part, " \t"))
	}
	return list
}

type pinnedByteRange struct {
	start int64
	end   int64
}

type pinnedRangeOutcome int

const (
	pinnedRangeOK pinnedRangeOutcome = iota
	pinnedRangeUnsatisfiable
	pinnedRangeStale
)

// pinnedParseRange mirrors range-parser's parseRange with the combine option
// send() passes. A malformed and an unsatisfiable range both end up as
// unsatisfiable, which is why send() answers 416 for "bytes=abc" as well.
func pinnedParseRange(size int64, header string) ([]pinnedByteRange, pinnedRangeOutcome) {
	index := strings.IndexByte(header, '=')
	if index == -1 || strings.TrimSpace(header[:index]) != "bytes" {
		return nil, pinnedRangeStale
	}
	ranges := make([]pinnedByteRange, 0)
	for _, item := range strings.Split(header[index+1:], ",") {
		parts := strings.SplitN(item, "-", 2)
		if len(parts) != 2 {
			continue
		}
		start, startErr := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
		end, endErr := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		switch {
		case startErr != nil && endErr != nil:
			continue
		case startErr != nil:
			start = size - end
			end = size - 1
		case endErr != nil:
			end = size - 1
		}
		if start > end || start < 0 || end > size-1 {
			continue
		}
		ranges = append(ranges, pinnedByteRange{start: start, end: end})
	}
	if len(ranges) == 0 {
		return nil, pinnedRangeUnsatisfiable
	}
	sort.SliceStable(ranges, func(left, right int) bool { return ranges[left].start < ranges[right].start })
	combined := ranges[:1]
	for _, candidate := range ranges[1:] {
		last := &combined[len(combined)-1]
		if candidate.start <= last.end+1 {
			if candidate.end > last.end {
				last.end = candidate.end
			}
			continue
		}
		combined = append(combined, candidate)
	}
	return combined, pinnedRangeOK
}

// respondPinnedExtensionErrorPage writes the response GoTavern produces where
// Express renders finalhandler's page. Only the status, the content type and,
// for 416, Content-Range are comparable with the pinned fixture.
func respondPinnedExtensionErrorPage(w http.ResponseWriter, status int, contentRange string) {
	if contentRange != "" {
		w.Header().Set("Content-Range", contentRange)
	}
	body := []byte(pinnedSendErrorDocument(status))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// pinnedSendErrorDocument is send()'s createHtmlDocument('Error', message).
func pinnedSendErrorDocument(status int) string {
	return "<!DOCTYPE html>\n" +
		"<html lang=\"en\">\n" +
		"<head>\n" +
		"<meta charset=\"utf-8\">\n" +
		"<title>Error</title>\n" +
		"</head>\n" +
		"<body>\n" +
		"<pre>" + html.EscapeString(http.StatusText(status)) + "</pre>\n" +
		"</body>\n" +
		"</html>\n"
}

// pinnedExtensionMediaType is exposed for the test's diagnostics.
func pinnedExtensionMediaType(name string) string {
	return pinnedMimeV1ContentType(path.Base(name))
}
