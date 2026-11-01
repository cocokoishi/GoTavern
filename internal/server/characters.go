package server

// Route registration and shared request handling for the pinned characters
// domain (src/endpoints/characters.js).

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
	"gopkg.in/yaml.v3"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerCharactersRoutes)
}

func registerCharactersRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	lazyLoadCharacters := charactersLazyLoadEnabled(options)
	post := func(pattern string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/characters/all", func(w http.ResponseWriter, r *http.Request) {
		accounts.serveCharactersAll(w, r, lazyLoadCharacters)
	})
	post("/api/characters/get", accounts.serveCharactersGet)
	post("/api/characters/chats", accounts.serveCharactersChats)
	post("/api/characters/create", accounts.serveCharactersCreate)
	post("/api/characters/rename", accounts.serveCharactersRename)
	post("/api/characters/edit", accounts.serveCharactersEdit)
	post("/api/characters/edit-avatar", accounts.serveCharactersEditAvatar)
	post("/api/characters/edit-attribute", accounts.serveCharactersEditAttribute)
	post("/api/characters/merge-attributes", accounts.serveCharactersMergeAttributes)
	post("/api/characters/delete", accounts.serveCharactersDelete)
	post("/api/characters/import", accounts.serveCharactersImport)
	post("/api/characters/duplicate", accounts.serveCharactersDuplicate)
	post("/api/characters/export", accounts.serveCharactersExport)
}

// charactersLazyLoadEnabled resolves performance.lazyLoadCharacters the way the
// pinned getConfigValue does: environment override first, then the runtime
// config file, then the pinned default of false.
func charactersLazyLoadEnabled(options HTTPHandlerOptions) bool {
	if raw, exists := os.LookupEnv("SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS"); exists {
		return pinnedToBoolean(raw)
	}
	for _, candidate := range charactersConfigCandidates(options) {
		body, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		var parsed map[string]any
		if yaml.Unmarshal(body, &parsed) != nil {
			continue
		}
		value, exists := parsed["performance"]
		if !exists {
			return false
		}
		section, ok := value.(map[string]any)
		if !ok {
			return false
		}
		raw, exists := section["lazyLoadCharacters"]
		if !exists {
			return false
		}
		return pinnedToBoolean(raw)
	}
	return false
}

func charactersConfigCandidates(options HTTPHandlerOptions) []string {
	candidates := make([]string, 0, 2)
	if options.InstallRoot != "" {
		candidates = append(candidates, filepath.Join(options.InstallRoot, "config.yaml"))
	}
	if options.DataRoot != "" {
		candidates = append(candidates, filepath.Join(filepath.Dir(options.DataRoot), "config.yaml"))
	}
	return candidates
}

// pinnedToBoolean mirrors util.js toBoolean.
func pinnedToBoolean(value any) bool {
	if text, ok := value.(string); ok {
		switch strings.ToLower(strings.TrimSpace(text)) {
		case "true":
			return true
		case "false":
			return false
		}
		return text != ""
	}
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case int:
		return typed != 0
	case int64:
		return typed != 0
	case float64:
		return typed != 0
	default:
		return true
	}
}

// charactersDirectories resolves the pinned user directories for the request.
func (runtime *accountRuntime) charactersDirectories(account *storedAccount) (map[string]string, bool) {
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		return nil, false
	}
	return directories, true
}

// respondCharacterJSON mirrors express `res.send(object)` for a JSON body.
func respondCharacterJSON(w http.ResponseWriter, status int, value orderedNodeJSON) {
	body, err := marshalCharacterJSON(value)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	writeCharacterJSONBody(w, status, body)
}

func writeCharacterJSONBody(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// serveCharactersOverflow mirrors the /all error branch that distinguishes a
// V8 RangeError from every other failure.
func serveCharactersOverflow(w http.ResponseWriter, overflow bool) {
	body := nodeObject()
	body.setMember("overflow", nodeBool(overflow))
	body.setMember("error", nodeBool(true))
	respondCharacterJSON(w, http.StatusInternalServerError, body)
}

// readCharactersBody parses a JSON or simple URL-encoded request body the way
// the pinned body-parser middleware would.
func readCharactersBody(request *http.Request) (orderedNodeJSON, bool) {
	contentType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err == nil && contentType == "application/x-www-form-urlencoded" {
		body, err := io.ReadAll(io.LimitReader(request.Body, pinnedBodyParserLimit+1))
		if err != nil || int64(len(body)) > pinnedBodyParserLimit {
			return orderedNodeJSON{}, false
		}
		values, err := parseSimpleFormBody(string(body))
		if err != nil {
			return orderedNodeJSON{}, false
		}
		return values, true
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, pinnedBodyParserLimit+1))
	if err != nil || int64(len(body)) > pinnedBodyParserLimit {
		return orderedNodeJSON{}, false
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nodeObject(), true
	}
	parsed, err := decodeOrderedNodeJSON([]byte(trimmed))
	if err != nil || parsed.kind != 'o' {
		return orderedNodeJSON{}, false
	}
	return parsed, true
}

func parseSimpleFormBody(body string) (orderedNodeJSON, error) {
	result := nodeObject()
	for _, pair := range strings.Split(body, "&") {
		if pair == "" {
			continue
		}
		key, value, _ := strings.Cut(pair, "=")
		decodedKey, err := url.QueryUnescape(key)
		if err != nil {
			return orderedNodeJSON{}, err
		}
		decodedValue, err := url.QueryUnescape(value)
		if err != nil {
			return orderedNodeJSON{}, err
		}
		if existing, exists := result.member(decodedKey); exists {
			if existing.kind == 'a' {
				existing.array = append(existing.array, nodeString(decodedValue))
				result.setMember(decodedKey, existing)
				continue
			}
			result.setMember(decodedKey, nodeArray(existing, nodeString(decodedValue)))
			continue
		}
		result.setMember(decodedKey, nodeString(decodedValue))
	}
	return result, nil
}

// charactersRequest carries the parsed body plus the staged multipart file.
type charactersRequest struct {
	body         orderedNodeJSON
	stagedPath   string
	originalName string
}

func (runtime *accountRuntime) readCharactersRequest(request *http.Request) (charactersRequest, error) {
	contentType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err == nil && strings.HasPrefix(contentType, "multipart/form-data") {
		return parseCharactersMultipart(request, runtime.options.DataRoot)
	}
	body, ok := readCharactersBody(request)
	if !ok {
		return charactersRequest{}, errors.New("invalid request body")
	}
	return charactersRequest{body: body}, nil
}

// parseCharactersMultipart collects the text fields multer would place on
// request.body and stages the single `avatar` file upload.
func parseCharactersMultipart(request *http.Request, dataRoot string) (charactersRequest, error) {
	reader, err := request.MultipartReader()
	if err != nil {
		return charactersRequest{}, err
	}
	result := charactersRequest{body: nodeObject()}
	cleanup := func() {
		if result.stagedPath != "" {
			_ = os.Remove(result.stagedPath)
		}
	}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			cleanup()
			return charactersRequest{}, err
		}
		fieldName := part.FormName()
		fileName := part.FileName()
		if fileName == "" {
			fieldBytes, err := io.ReadAll(io.LimitReader(part, pinnedUploadFieldSizeLimit+1))
			closeErr := part.Close()
			if err != nil || closeErr != nil || int64(len(fieldBytes)) > pinnedUploadFieldSizeLimit {
				cleanup()
				if err != nil {
					return charactersRequest{}, err
				}
				if closeErr != nil {
					return charactersRequest{}, closeErr
				}
				return charactersRequest{}, errors.New("multipart field exceeds the pinned size limit")
			}
			appendCharactersMultipartField(&result.body, fieldName, nodeString(string(fieldBytes)))
			continue
		}
		if fieldName != "avatar" || result.stagedPath != "" {
			_ = part.Close()
			cleanup()
			return charactersRequest{}, errors.New("unexpected multipart file field")
		}
		staged, createErr := startup.CreateUploadStagingFile(dataRoot)
		if createErr != nil {
			_ = part.Close()
			cleanup()
			return charactersRequest{}, createErr
		}
		result.stagedPath = staged.Name()
		_, copyErr := io.Copy(staged, part)
		partCloseErr := part.Close()
		stagedCloseErr := staged.Close()
		if copyErr != nil || partCloseErr != nil || stagedCloseErr != nil {
			cleanup()
			if copyErr != nil {
				return charactersRequest{}, copyErr
			}
			if partCloseErr != nil {
				return charactersRequest{}, partCloseErr
			}
			return charactersRequest{}, stagedCloseErr
		}
		result.originalName = decodeMulterOriginalFilename(fileName)
	}
	return result, nil
}

// removeStagedCharacterUpload removes the multer staging file.
func removeStagedCharacterUpload(path string) {
	if path == "" {
		return
	}
	_ = os.Remove(path)
}

// appendCharactersMultipartField reproduces how multer accumulates TEXT fields on
// request.body, because a repeated field is an ARRAY upstream and a string here.
//
// The pinned server mounts `multer(...).single('avatar')` globally
// (src/server-main.js:269), and multer 2.1.1 calls append-field 1.0.0's
// appendField for every `field` event (node_modules/multer/lib/make-middleware.js:150).
// append-field's setLastValue turns the first occurrence into the value, the
// second into [first, second], and pushes every further one
// (node_modules/append-field/lib/set-value.js). The character route consumes that
// shape: charaFormatData's getAlternateGreetings accepts an ARRAY and wraps a
// string (src/endpoints/characters.js:584-588), and the pinned frontend appends
// one `alternate_greetings` part per greeting (public/script.js:9786 for create,
// :9879 for edit).
//
// MEASURED, NOT DERIVED: the Node->Go->Node gate sent two alternate greetings
// through /api/characters/edit and the stored card kept ONE, because this parser
// overwrote the field on each part. A user editing a card with alternate
// greetings in the unmodified frontend loses all but the last one.
//
// The whole `req.body` is post-multipart JSON to the route, so only the plain-key
// shapes append-field can reach from the pinned frontend are reproduced: scalar
// first, array after. Bracketed field names (`a[b]`) would need append-field's
// path parser, and the pinned frontend builds none (every formData.append site in
// public/script.js uses a plain name), so they are left as literal keys rather
// than guessing at a shape no caller sends.
func appendCharactersMultipartField(body *orderedNodeJSON, fieldName string, value orderedNodeJSON) {
	if fieldName == "" {
		body.setMember(fieldName, value)
		return
	}
	existing, exists := body.member(fieldName)
	if !exists {
		body.setMember(fieldName, value)
		return
	}
	switch existing.kind {
	case 'a':
		existing.array = append(existing.array, value)
		body.setMember(fieldName, existing)
	case 'o':
		// append-field's object branch stores the new value under the "" key
		// (set-value.js setLastValue case 'object'). No pinned frontend field
		// reaches this shape, but it is reproduced rather than approximated.
		existing.setMember("", value)
		body.setMember(fieldName, existing)
	default:
		body.setMember(fieldName, nodeArray(existing, value))
	}
}
