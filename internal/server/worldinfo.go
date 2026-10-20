package server

// Pinned world-info routes, from src/endpoints/worldinfo.js:
//
//	POST /api/worldinfo/list   worldinfo.js:39
//	POST /api/worldinfo/get    worldinfo.js:71
//	POST /api/worldinfo/delete worldinfo.js:81
//	POST /api/worldinfo/import worldinfo.js:99
//	POST /api/worldinfo/edit   worldinfo.js:134
//
// The deprecated aliases /getworldinfo, /deleteworldinfo, /importworldinfo and
// /editworldinfo are the method-preserving 308 redirects registered by
// src/server-startup.js:110-113.
//
// Known gaps, recorded in docs/compat-matrix.md:
//
//   - /delete throws when the world file does not exist, /get throws when the
//     file is not parsable JSON, and /get throws when the requested name cannot
//     be stringified. Express answers every one of those with its finalhandler
//     HTML error page (status 500) whose <pre> block is the V8 stack trace,
//     which embeds host-absolute source paths and pinned line numbers. GoTavern
//     answers the same 500 status with the plain-text body serveStatusText
//     produces and does not reproduce that page.
//   - Express's default JSON body parser answers a malformed or non-object body
//     with its own 400 HTML error page; GoTavern answers 400 with a plain-text
//     body.
//   - Express's JSON body parser limit (100kb) is not enforced; the pinned
//     multer field limit reused by the other user-data domains (500MB) is.
//   - Express matches a trailing-slash request path (/api/worldinfo/get/) while
//     net/http's ServeMux does not.
//   - an unexpected multipart file field is rejected by multer with its own 500
//     error page; GoTavern answers 400.
//
// The pinned read of a world file returns whatever JSON.parse produced, so the
// response is res.send() of an object, array, string, boolean, number or null.
// Each of those has a different Express response shape and all of them are
// reproduced here.

import (
	"io"
	"math"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerWorldInfoRoutes)
}

func registerWorldInfoRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	// Every pinned world-info route is POST-only. Express answers any other
	// method with the final 404, so dispatch manually instead of letting
	// net/http build a 405.
	post := func(path string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/worldinfo/list", accounts.serveWorldInfoList)
	post("/api/worldinfo/get", accounts.serveWorldInfoGet)
	post("/api/worldinfo/delete", accounts.serveWorldInfoDelete)
	post("/api/worldinfo/import", accounts.serveWorldInfoImport)
	post("/api/worldinfo/edit", accounts.serveWorldInfoEdit)

	// res.redirect(308, destination) preserves the request method.
	redirect := func(source, destination string) {
		mux.HandleFunc(source, func(w http.ResponseWriter, r *http.Request) {
			serveRedirect(w, r, http.StatusPermanentRedirect, destination)
		})
	}
	redirect("/getworldinfo", "/api/worldinfo/get")
	redirect("/deleteworldinfo", "/api/worldinfo/delete")
	redirect("/importworldinfo", "/api/worldinfo/import")
	redirect("/editworldinfo", "/api/worldinfo/edit")
}

// readPinnedJSONBody reproduces the pinned express.json() middleware for these
// routes. A body that does not carry a JSON content type becomes the empty
// object that body-parser leaves on request.body, and so does a zero-length
// body, which body-parser special-cases before parsing. A malformed body, or a
// body that is neither an object nor an array (body-parser's strict mode), is
// rejected with the parser's 400.
func readPinnedJSONBody(request *http.Request) (orderedNodeJSON, bool) {
	contentType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	// The pinned parser's type is exactly application/json: type-is does not
	// match a +json suffix, so those requests skip parsing too.
	if err != nil || contentType != "application/json" {
		return nodeObject(), true
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, pinnedBodyParserLimit+1))
	if err != nil || int64(len(body)) > pinnedBodyParserLimit {
		return orderedNodeJSON{}, false
	}
	if len(body) == 0 {
		return nodeObject(), true
	}
	parsed, err := decodeOrderedNodeJSON(body)
	if err != nil {
		return orderedNodeJSON{}, false
	}
	if parsed.kind != 'o' && parsed.kind != 'a' {
		return orderedNodeJSON{}, false
	}
	return parsed, true
}

// pinnedWorldInfoFilename applies sanitize(`${name}.json`) to the JavaScript
// string form of a request member. It reports false when JavaScript's ToString
// throws, which is what happens for an object carrying a non-callable
// `toString` member.
func pinnedWorldInfoFilename(value orderedNodeJSON) (string, bool) {
	text, err := value.javascriptString()
	if err != nil {
		return "", false
	}
	return startup.SanitizeUserFilename(text + ".json"), true
}

// nodePathName mirrors Node's path.parse(name).name for a single path segment.
func nodePathName(name string) string {
	return strings.TrimSuffix(name, nodePathExt(name))
}

// localeCompareLess approximates the pinned `a.localeCompare(b)` ordering that
// src/endpoints/worldinfo.js:44 applies to world file names. Node collates with
// the host's default ICU locale, which Go does not implement; this is the same
// case-insensitive-then-byte approximation the settings aggregation already
// uses. The oracle fixture only seeds lower-case ASCII names, so the recorded
// order does not depend on the host collation.
func localeCompareLess(left, right string) bool {
	leftFolded, rightFolded := strings.ToLower(left), strings.ToLower(right)
	if leftFolded == rightFolded {
		return left < right
	}
	return leftFolded < rightFolded
}

// respondWorldInfoSend reproduces Express res.send(JSON.parse(text)) for a world
// file. Objects and arrays serialize as JSON, a string is written as text/html
// without JSON quoting, a boolean serializes as JSON, and null becomes an empty
// body without a Content-Type. res.send(number) is a status-code form and is
// handled by the caller.
func respondWorldInfoSend(w http.ResponseWriter, value orderedNodeJSON) {
	switch value.kind {
	case 'o', 'a':
		respondOrderedNodeJSON(w, http.StatusOK, value)
	case 's':
		respondText(w, http.StatusOK, "text/html; charset=utf-8", value.scalar.(string))
	case 'b':
		respondJSON(w, http.StatusOK, value.scalar.(bool))
	case 'n':
		// res.send(null) writes an empty body and leaves Content-Type unset. The
		// pinned compression middleware only appends Accept-Encoding to Vary when
		// the response carries a compressible Content-Type, so this response keeps
		// the CORS middleware's bare Vary: Origin. The oracle fixture records that
		// difference; the shared security middleware would otherwise claim
		// Accept-Encoding for a response it never encoded.
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Content-Length", "0")
		w.Header().Set("ETag", expressWeakETag(nil))
		w.WriteHeader(http.StatusOK)
	default:
		serveWorldInfoNumberStatus(w, value.scalar.(float64))
	}
}

// serveWorldInfoNumberStatus reproduces res.send(number): Express treats the
// argument as a status code and writes statuses.message[status] as text. A code
// outside the range Node accepts throws while the response is ended, so Express
// renders its 500 error page instead. A fractional value is not probed: Node
// truncates the status code but looks the message up with the original number,
// so it answers that truncated status with an empty body.
func serveWorldInfoNumberStatus(w http.ResponseWriter, status float64) {
	code := int(status)
	if math.IsNaN(status) || math.IsInf(status, 0) || status != float64(code) || code < 100 || code > 999 {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, code)
}

// readWorldInfoRouteFile mirrors the pinned helper for the world-info routes
// themselves. A falsy name or a missing file returns the dummy `{entries:{}}`
// object (or null when allowDummy is unset), and every other failure is thrown
// to Express: the second result is false. It is separate from the characters
// domain's readWorldInfoFile, which mirrors the pinned allowDummy=false call.
func readWorldInfoRouteFile(directories startup.UserDirectories, name orderedNodeJSON, allowDummy bool) (orderedNodeJSON, bool) {
	if !jsTruthy(name) {
		return worldInfoDummyOrNull(allowDummy), true
	}
	filename, valid := pinnedWorldInfoFilename(name)
	if !valid {
		return orderedNodeJSON{}, false
	}
	target := filepath.Join(directories["worlds"], filename)
	if _, err := os.Stat(target); err != nil {
		// Pinned readWorldInfoFile logs the missing file and returns the dummy.
		return worldInfoDummyOrNull(allowDummy), true
	}
	contents, err := os.ReadFile(target)
	if err != nil {
		return orderedNodeJSON{}, false
	}
	parsed, err := decodeOrderedNodeJSON(contents)
	if err != nil {
		return orderedNodeJSON{}, false
	}
	return parsed, true
}

func worldInfoDummyOrNull(allowDummy bool) orderedNodeJSON {
	if !allowDummy {
		return orderedNodeJSON{kind: 'n'}
	}
	return orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{{key: "entries", value: nodeObject()}}}
}

func (runtime *accountRuntime) serveWorldInfoList(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	worldsDirectory := directories["worlds"]
	entries, err := os.ReadDir(worldsDirectory)
	if err != nil {
		// Pinned worldinfo.js:65-68 answers sendStatus(500) when readdir fails.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// The pinned filter is `file.isFile() && path.extname(file.name).toLowerCase()
	// === '.json'` on Dirents from withFileTypes, so symlinks and directories are
	// excluded before the name sort.
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		if !strings.EqualFold(nodePathExt(entry.Name()), ".json") {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.SliceStable(names, func(left, right int) bool { return localeCompareLess(names[left], names[right]) })

	data := orderedNodeJSON{kind: 'a', array: make([]orderedNodeJSON, 0, len(names))}
	for _, name := range names {
		// The pinned per-file try/catch skips a file that cannot be read or
		// parsed; tryParse() returns undefined, which the endpoint replaces
		// with an empty object.
		contents, err := os.ReadFile(filepath.Join(worldsDirectory, name))
		if err != nil {
			continue
		}
		parsed, err := decodeOrderedNodeJSON(contents)
		if err != nil {
			parsed = nodeObject()
		}
		fileID := nodePathName(name)
		fileData := nodeObject()
		fileData.setMember("file_id", nodeString(fileID))
		if parsed.kind == 'o' {
			if parsedName, exists := parsed.member("name"); exists && jsTruthy(parsedName) {
				fileData.setMember("name", parsedName)
			} else {
				fileData.setMember("name", nodeString(fileID))
			}
		} else {
			fileData.setMember("name", nodeString(fileID))
		}
		fileExtensions := nodeObject()
		if parsed.kind == 'o' {
			if extensions, exists := parsed.member("extensions"); exists && jsTruthy(extensions) {
				// lodash isObjectLike() accepts arrays as well as objects.
				if extensions.kind == 'o' || extensions.kind == 'a' {
					fileExtensions = extensions
				}
			}
		}
		fileData.setMember("extensions", fileExtensions)
		data.array = append(data.array, fileData)
	}
	respondOrderedNodeJSON(w, http.StatusOK, data)
}

func (runtime *accountRuntime) serveWorldInfoGet(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	body, ok := readPinnedJSONBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	name := nodeGet(body, "name")
	if !jsTruthy(name) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	worldInfo, ok := readWorldInfoRouteFile(directories, name, true)
	if !ok {
		// JSON.parse, the template literal's ToString or readFileSync threw.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondWorldInfoSend(w, worldInfo)
}

func (runtime *accountRuntime) serveWorldInfoDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	body, ok := readPinnedJSONBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	name := nodeGet(body, "name")
	if !jsTruthy(name) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	filename, ok := pinnedWorldInfoFilename(name)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// The pinned route throws when existsSync is false, which Express renders as
	// its 500 error page.
	if _, err := os.Stat(filepath.Join(directories["worlds"], filename)); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	found, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), filepath.Join("worlds", filename))
	if err != nil || !found {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}

func (runtime *accountRuntime) serveWorldInfoImport(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if parsed.stagedPath == "" {
		// Pinned worldinfo.js:100: multer did not stage an `avatar` file.
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	// The pinned branch order matters: a truthy convertedData field wins, and
	// only the file branch unlinks the multer staging file. The staged upload is
	// deliberately left in DATA_ROOT/_uploads when convertedData is used, which
	// the oracle fixture records.
	convertedData := nodeGet(parsed.body, "convertedData")
	var fileContents []byte
	if jsTruthy(convertedData) {
		text, stringErr := convertedData.javascriptString()
		if stringErr != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		fileContents = []byte(text)
	} else {
		contents, readErr := os.ReadFile(parsed.stagedPath)
		if readErr != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		fileContents = contents
		removeStagedCharacterUpload(parsed.stagedPath)
	}
	// Pinned `'entries' in worldContent`: a scalar or null throws, an array
	// inherits Array.prototype.entries and therefore passes, and an object needs
	// the own member.
	worldContent, parseErr := decodeOrderedNodeJSON(fileContents)
	validWorld := parseErr == nil
	if validWorld {
		switch worldContent.kind {
		case 'o':
			_, validWorld = worldContent.member("entries")
		case 'a':
			validWorld = true
		default:
			validWorld = false
		}
	}
	if !validWorld {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Is not a valid world info file")
		return
	}
	filename := startup.SanitizeUserFilename(nodePathName(startup.SanitizeUserFilename(parsed.originalName)) + ".json")
	worldName := nodePathName(filename)
	if worldName == "" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "World file must have a name")
		return
	}
	if err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), filepath.Join("worlds", filename), func([]byte) ([]byte, error) {
		return fileContents, nil
	}); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "name", value: nodeString(worldName)},
	}})
}

func (runtime *accountRuntime) serveWorldInfoEdit(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	body, ok := readPinnedJSONBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	name := nodeGet(body, "name")
	if !jsTruthy(name) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "World file must have a name")
		return
	}
	// Pinned `'entries' in request.body.data` throws for every scalar (including
	// null), so those answer 400 with the invalid-file text. For an array the
	// check succeeds without an own member, because `entries` is inherited from
	// Array.prototype, and the route then writes JSON.stringify(array, null, 4).
	data := nodeGet(body, "data")
	validData := false
	switch data.kind {
	case 'o':
		_, validData = data.member("entries")
	case 'a':
		validData = true
	}
	if !validData {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Is not a valid world info file")
		return
	}
	filename, ok := pinnedWorldInfoFilename(name)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	contents, err := marshalCharacterJSONIndent(data)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), filepath.Join("worlds", filename), func([]byte) ([]byte, error) {
		return contents, nil
	}); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "ok", value: nodeBool(true)},
	}})
}
