package server

// Pinned /api/content/importUUID, from src/endpoints/content-manager.js:1071, implemented only for
// the branch whose downloader already exists: AICC. Every other branch calls an unimplemented
// provider downloader (chub character/lorebook, janitorai, pygmalion, perchance) and answers 501 so
// it stays distinguishable from a policy refusal (AGENTS.md verification rule 17).
//
// UUID dispatch, source-derived and unit-tested (the pinned server would fetch for these shapes, so
// a 501 "oracle" would be a fake fixture):
//
//	isJanny    = uuid.includes('_character')
//	isPygmalion= !isJanny && uuid.length == 36      (JS .length: UTF-16 code units)
//	isAICC     = uuid.startsWith('AICC/')
//	isPerchance= /^\w+~[a-f0-9]{32}\.gz$/
//	uuidType   = uuid.includes('lorebook') ? 'lorebook' : 'character'
//	order: pygmalion, janny, AICC, perchance, else chub
//
// The AICC branch destructures uuid.split('/') as [, author, card], so 'AICC/only' becomes
// 'only/undefined'; the response envelope differs from importURL: Content-Disposition carries the
// RAW filename (no encodeURI) and X-Custom-Content-Type is the uuidType.
//
// Evidence: tools/probe-content-uuid.mjs records tests/oracle/sillytavern-1.19.0-content-uuid.json
// from the pinned server; content_test.go replays it and also covers the classifier and the 501
// dispatch (including zero outbound requests).

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// contentPerchanceUUIDPattern is /^\w+~[a-f0-9]{32}\.gz$/ (JS \w = [A-Za-z0-9_]).
var contentPerchanceUUIDPattern = regexp.MustCompile(`^[A-Za-z0-9_]+~[a-f0-9]{32}\.gz$`)

// contentImportUUIDKind is the dispatch result of the source-derived classifier.
type contentImportUUIDKind string

const (
	contentUUIDKindPygmalion     contentImportUUIDKind = "pygmalion"
	contentUUIDKindJanny         contentImportUUIDKind = "janny"
	contentUUIDKindAICC          contentImportUUIDKind = "aicc"
	contentUUIDKindPerchance     contentImportUUIDKind = "perchance"
	contentUUIDKindChubCharacter contentImportUUIDKind = "chub-character"
	contentUUIDKindChubLorebook  contentImportUUIDKind = "chub-lorebook"
)

// contentClassifyImportUUID mirrors the pinned dispatch order and predicates.
func contentClassifyImportUUID(uuid string) contentImportUUIDKind {
	isJanny := strings.Contains(uuid, "_character")
	utf16Length := len(utf16.Encode([]rune(uuid)))
	isPygmalion := !isJanny && utf16Length == 36
	isAICC := strings.HasPrefix(uuid, "AICC/")
	isPerchance := contentPerchanceUUIDPattern.MatchString(uuid)
	switch {
	case isPygmalion:
		return contentUUIDKindPygmalion
	case isJanny:
		return contentUUIDKindJanny
	case isAICC:
		return contentUUIDKindAICC
	case isPerchance:
		return contentUUIDKindPerchance
	case strings.Contains(uuid, "lorebook"):
		return contentUUIDKindChubLorebook
	default:
		return contentUUIDKindChubCharacter
	}
}

// contentAICCUUIDID is the pinned `const [, author, card] = uuid.split('/')` destructuring: a
// missing segment is the literal string "undefined".
func contentAICCUUIDID(uuid string) string {
	parts := strings.Split(uuid, "/")
	author := "undefined"
	card := "undefined"
	if len(parts) > 1 {
		author = parts[1]
	}
	if len(parts) > 2 {
		card = parts[2]
	}
	return author + "/" + card
}

// contentDownloadAICC is downloadAICCCharacter shared by importURL and importUUID.
func contentDownloadAICC(request *http.Request, id string) (contentImportResult, bool) {
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method: http.MethodGet,
		URL:    contentAICCURL() + "/wp-json/pngapi/v1/image/" + id,
	})
	if fetchErr != nil || !sdResponseOK(response) {
		return contentImportResult{}, false
	}
	fileType := response.Header("content-type")
	if fileType == "" {
		fileType = "image/png"
	}
	return contentImportResult{
		buffer:   response.Body,
		fileName: startup.SanitizeUserFilename(id) + ".png",
		fileType: fileType,
	}, true
}

// contentSendImportUUID is importUUID's response tail: unlike importURL it writes the RAW fileName
// into Content-Disposition and uses the uuidType as X-Custom-Content-Type.
func contentSendImportUUID(w http.ResponseWriter, result contentImportResult, uuidType string) {
	if result.fileType != "" {
		w.Header().Set("Content-Type", result.fileType)
	}
	w.Header().Set("Content-Disposition", "attachment; filename=\""+result.fileName+"\"")
	w.Header().Set("X-Custom-Content-Type", uuidType)
	w.Header().Set("Content-Length", strconv.Itoa(len(result.buffer)))
	w.Header().Set("ETag", expressWeakETag(result.buffer))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.buffer)
}

func (runtime *accountRuntime) serveContentImportUUID(w http.ResponseWriter, request *http.Request) {
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
	uuid, stringErr := pinnedJSStringValue(urlNode)
	if stringErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	uuidType := "character"
	if strings.Contains(uuid, "lorebook") {
		uuidType = "lorebook"
	}
	kind := contentClassifyImportUUID(uuid)
	if kind != contentUUIDKindAICC {
		// Unimplemented provider downloader: 501, never a 404 that would be indistinguishable from
		// a policy refusal (AGENTS.md rule 17).
		serveStatusText(w, http.StatusNotImplemented)
		return
	}
	result, downloadOK := contentDownloadAICC(request, contentAICCUUIDID(uuid))
	if !downloadOK {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	contentSendImportUUID(w, result, uuidType)
}
