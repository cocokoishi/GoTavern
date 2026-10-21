package server

// Pinned /api/content/importURL branches implemented this round, from
// src/endpoints/content-manager.js:978:
//
//	aicharactercards.com  -> downloadAICCCharacter: one hardcoded GET, contentType from the
//	                         response (default image/png), fileName sanitize(id)+".png"
//	generic whitelisted   -> downloadGenericPng: caller-supplied GET, fileName derived from the
//	                         RESPONSE url (split('?')[0], last '/' segment, sanitize), ".png"
//	                         appended when the content type is image/png and the name has no
//	                         extension
//	refusal               -> host neither a provider nor in whitelistImportDomains: 404
//
// DEFERRED, and explicit rather than fake: chub/characterhub (character and lorebook), janitorai,
// pygmalion, risu and perchance answer 501 Not Implemented; /api/content/importUUID is not
// registered. SECURITY PROPERTY (AGENTS.md boundary 4): pinned classifies providers by SUBSTRING
// matching on the hostname, so chub.ai.attacker.example passes isChub and is treated as chub; only
// the generic branch is an exact whitelistImportDomains match. That inherited property is recorded
// in the compat row, not silently changed here.
//
// Evidence: tools/probe-content.mjs records tests/oracle/sillytavern-1.19.0-content.json from the
// pinned server (stub response carries `url`, so downloadGenericPng's filename derivation is
// observable), and internal/server/content_test.go replays it.

import (
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const contentAICCDefaultURL = "https://aicharactercards.com"

func contentAICCURL() string { return sdSeamURL("GOTAVERN_CONTENT_AICC_URL", contentAICCDefaultURL) }

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerContentRoutes)
}

func registerContentRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/content/importURL", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveContentImportURL(w, r)
	})
}

// contentHostFromURL is getHostFromUrl: the parsed hostname, or ” when the URL does not parse.
func contentHostFromURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return ""
	}
	return parsed.Hostname()
}

// contentParseAICC is parseAICC: the last two path segments, from the parsed pathname when the URL
// is valid and from a raw split otherwise.
func contentParseAICC(rawURL string) (string, bool) {
	parts := []string{}
	if parsed, err := url.Parse(rawURL); err == nil && parsed.Host != "" {
		for _, segment := range strings.Split(parsed.Path, "/") {
			if segment != "" {
				parts = append(parts, segment)
			}
		}
	} else {
		for _, segment := range strings.Split(rawURL, "/") {
			if segment != "" {
				parts = append(parts, segment)
			}
		}
	}
	if len(parts) < 2 {
		return "", false
	}
	return parts[len(parts)-2] + "/" + parts[len(parts)-1], true
}

// contentEncodeURI is JavaScript encodeURI: unlike encodeURIComponent it leaves the reserved set
// ; / ? : @ & = + $ , # unescaped. Content-Disposition uses it, so a filename with '&' or ';' must
// stay literal (the fixture's generic.reservedChars step pins this).
func contentEncodeURI(value string) string {
	const unescaped = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'();/?:@&=+$,#"
	var builder strings.Builder
	for _, iterator := range []byte(value) {
		if strings.IndexByte(unescaped, iterator) >= 0 {
			builder.WriteByte(iterator)
			continue
		}
		builder.WriteByte('%')
		hexValue := strconv.FormatUint(uint64(iterator), 16)
		if len(hexValue) == 1 {
			builder.WriteByte('0')
		}
		builder.WriteString(strings.ToUpper(hexValue))
	}
	return builder.String()
}

// contentImportResult is the {buffer, fileName, fileType} triple the downloaders return.
type contentImportResult struct {
	buffer   []byte
	fileName string
	fileType string
}

// contentSendImport is the shared response tail: set the optional file type, the attachment
// disposition and the custom-content-type marker, then send the buffer (weak ETag + length).
func contentSendImport(w http.ResponseWriter, result contentImportResult, contentTypeValue string) {
	if result.fileType != "" {
		w.Header().Set("Content-Type", result.fileType)
	}
	w.Header().Set("Content-Disposition", "attachment; filename=\""+contentEncodeURI(result.fileName)+"\"")
	w.Header().Set("X-Custom-Content-Type", contentTypeValue)
	w.Header().Set("Content-Length", strconv.Itoa(len(result.buffer)))
	w.Header().Set("ETag", expressWeakETag(result.buffer))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.buffer)
}

var contentExtensionPattern = regexp.MustCompile(`\.\w+$`)

func (runtime *accountRuntime) serveContentImportURL(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	urlNode := sdBodyMember(body, "url")
	if !pinnedJSTruthy(urlNode) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	rawURL, stringErr := pinnedJSStringValue(urlNode)
	if stringErr != nil {
		rawURL = ""
	}
	host := contentHostFromURL(rawURL)

	isChub := strings.Contains(host, "chub.ai") || strings.Contains(host, "characterhub.org")
	isJanny := strings.Contains(host, "janitorai")
	isPygmalion := strings.Contains(host, "pygmalion.chat")
	isAICC := strings.Contains(host, "aicharactercards.com")
	isRisu := strings.Contains(host, "realm.risuai.net")
	isPerchance := strings.Contains(host, "perchance.org")
	isGeneric := false
	for _, allowed := range runtime.options.WhitelistImportDomains {
		if allowed == host {
			isGeneric = true
			break
		}
	}

	// Provider branches ported in later increments answer 501 rather than pretending the host was
	// refused: silently answering 404 here would misreport pinned behaviour.
	if isPygmalion || isJanny || isChub || isRisu || isPerchance {
		serveStatusText(w, http.StatusNotImplemented)
		return
	}

	if isAICC {
		id, valid := contentParseAICC(rawURL)
		if !valid {
			backendsStatus(w, http.StatusNotFound)
			return
		}
		response, fetchErr := searchFetch(request.Context(), searchRequest{
			Method: http.MethodGet,
			URL:    contentAICCURL() + "/wp-json/pngapi/v1/image/" + id,
		})
		if fetchErr != nil {
			backendsStatus(w, http.StatusInternalServerError)
			return
		}
		if !sdResponseOK(response) {
			backendsStatus(w, http.StatusInternalServerError)
			return
		}
		fileType := response.Header("content-type")
		if fileType == "" {
			fileType = "image/png"
		}
		contentSendImport(w, contentImportResult{
			buffer:   response.Body,
			fileName: startup.SanitizeUserFilename(id) + ".png",
			fileType: fileType,
		}, "character")
		return
	}

	if isGeneric {
		response, fetchErr := searchFetch(request.Context(), searchRequest{Method: http.MethodGet, URL: rawURL})
		if fetchErr != nil {
			backendsStatus(w, http.StatusInternalServerError)
			return
		}
		if !sdResponseOK(response) {
			backendsStatus(w, http.StatusNotFound)
			return
		}
		fileType := response.Header("content-type")
		if fileType == "" {
			fileType = "image/png"
		}
		// downloadGenericPng derives the name from the RESPONSE url: split('?')[0], last '/'
		// segment. Redirects are followed by the transport, so a redirected import keeps the
		// requested name rather than the final one; that is a stated limitation.
		withoutQuery := strings.SplitN(rawURL, "?", 2)[0]
		segments := strings.Split(withoutQuery, "/")
		fileName := startup.SanitizeUserFilename(segments[len(segments)-1])
		if fileType == "image/png" && !contentExtensionPattern.MatchString(fileName) {
			fileName += ".png"
		}
		contentSendImport(w, contentImportResult{buffer: response.Body, fileName: fileName, fileType: fileType}, "character")
		return
	}

	log.Printf("[content] Received an import for %q, but site is not whitelisted. This domain must be added to the config key \"whitelistImportDomains\" to allow import from this source.", host)
	backendsStatus(w, http.StatusNotFound)
}
