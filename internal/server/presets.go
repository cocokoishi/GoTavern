package server

// Pinned preset routes, from src/endpoints/presets.js:
//
//	POST /api/presets/save    presets.js:42
//	POST /api/presets/delete  presets.js:60
//	POST /api/presets/restore presets.js:83
//
// The apiId -> user directory mapping is getPresetSettingsByAPI (presets.js:16)
// and the restore path reads the pinned content index through getDefaultPresets
// and getDefaultPresetFile (content-manager.js:86,111).
//
// Known gaps, recorded in docs/compat-matrix.md:
//
//   - `sanitize(request.body.name)` throws for every non-string name, which
//     Express renders as its finalhandler HTML error page (status 500) whose
//     <pre> block is the V8 stack with host-absolute source paths. GoTavern
//     answers the same 500 status with the plain-text body serveStatusText
//     produces and does not reproduce that page. /restore wraps the same throw
//     in its own try/catch and answers sendStatus(500), which GoTavern
//     reproduces byte for byte.
//   - Express's JSON body parser answers a malformed or non-object body with its
//     own 400 HTML error page; GoTavern answers 400 with a plain-text body.
//   - Express matches a trailing-slash request path (/api/presets/save/) while
//     net/http's ServeMux does not.

import (
	"encoding/json"
	"net/http"
	"path"
	"path/filepath"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/upstream"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerPresetRoutes)
}

func registerPresetRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/presets/save", accounts.servePresetSave)
	post("/api/presets/delete", accounts.servePresetDelete)
	post("/api/presets/restore", accounts.servePresetRestore)
}

// presetAPIDirectoryKeys is the pinned getPresetSettingsByAPI mapping from an
// apiId to the user directory key that holds its presets.
var presetAPIDirectoryKeys = map[string]string{
	"kobold":              "koboldAI_Settings",
	"koboldhorde":         "koboldAI_Settings",
	"novel":               "novelAI_Settings",
	"textgenerationwebui": "textGen_Settings",
	"openai":              "openAI_Settings",
	"instruct":            "instruct",
	"context":             "context",
	"sysprompt":           "sysprompt",
	"reasoning":           "reasoning",
}

// presetContentTypeKeys is the pinned getUserTargetByType mapping restricted to
// the content types getDefaultPresets accepts. A type that is not in this table
// maps to the null folder that getUserTargetByType returns by default.
var presetContentTypeKeys = map[string]string{
	"kobold_preset":  "koboldAI_Settings",
	"openai_preset":  "openAI_Settings",
	"novel_preset":   "novelAI_Settings",
	"textgen_preset": "textGen_Settings",
	"instruct":       "instruct",
	"context":        "context",
	"sysprompt":      "sysprompt",
	"reasoning":      "reasoning",
}

// nullFolderKey stands in for the JavaScript null that getPresetSettingsByAPI
// and getUserTargetByType return for an unknown apiId or content type. It cannot
// collide with a directory key.
const nullFolderKey = "\x00null"

// pinnedSanitizedName mirrors `sanitize(request.body.name)` from
// sanitize-filename 1.6.3, which throws `Input must be string` for every
// non-string value instead of coercing it.
func pinnedSanitizedName(value orderedNodeJSON) (string, bool) {
	text, isString := value.stringValue()
	if !isString {
		return "", false
	}
	return startup.SanitizeUserFilename(text), true
}

// pinnedPresetFolder resolves the pinned getPresetSettingsByAPI result.
func pinnedPresetFolder(apiID orderedNodeJSON) (string, bool) {
	text, isString := apiID.stringValue()
	if !isString {
		return nullFolderKey, false
	}
	key, exists := presetAPIDirectoryKeys[text]
	if !exists {
		return nullFolderKey, false
	}
	return key, true
}

// pinnedContentPreset is one getDefaultPresets() entry: the file name it reads
// the preset from plus the name and folder it is matched against.
type pinnedContentPreset struct {
	filename  string
	name      string
	folderKey string
}

// pinnedDefaultPresets mirrors getDefaultPresets(directories) over the pinned
// content index. The scaffold index is read first when it exists, exactly as
// getContentIndex does, and a missing or unparsable index contributes nothing.
func pinnedDefaultPresets() []pinnedContentPreset {
	result := make([]pinnedContentPreset, 0)
	for _, index := range []string{"default/scaffold/index.json", "default/content/index.json"} {
		body, err := upstream.Assets.ReadFile(index)
		if err != nil {
			continue
		}
		var items []struct {
			Filename string `json:"filename"`
			Type     string `json:"type"`
		}
		if json.Unmarshal(body, &items) != nil {
			continue
		}
		for _, item := range items {
			if !strings.HasSuffix(item.Type, "_preset") &&
				item.Type != "instruct" && item.Type != "context" &&
				item.Type != "sysprompt" && item.Type != "reasoning" {
				continue
			}
			folderKey := nullFolderKey
			if key, exists := presetContentTypeKeys[item.Type]; exists {
				folderKey = key
			}
			result = append(result, pinnedContentPreset{
				filename:  item.Filename,
				name:      nodePathName(path.Base(item.Filename)),
				folderKey: folderKey,
			})
		}
	}
	return result
}

// pinnedDefaultPresetFile mirrors getDefaultPresetFile(filename): the file is
// always read from the pinned default/content directory, and a missing or
// unparsable file yields null, which the caller replaces with {}.
func pinnedDefaultPresetFile(filename string) (orderedNodeJSON, bool) {
	body, err := upstream.Assets.ReadFile(path.Join("default/content", filename))
	if err != nil {
		return orderedNodeJSON{}, false
	}
	parsed, err := decodeOrderedNodeJSON(body)
	if err != nil {
		return orderedNodeJSON{}, false
	}
	return parsed, true
}

// presetDirectoryPath resolves a user directory key to the path relative to the
// user root, which is what the shared user-content writer needs.
func (runtime *accountRuntime) presetDirectoryPath(handle, key string) (string, bool) {
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, handle)
	if err != nil {
		return "", false
	}
	directory, exists := directories[key]
	if !exists {
		return "", false
	}
	relative, err := filepath.Rel(directories["root"], directory)
	if err != nil {
		return "", false
	}
	return relative, true
}

func (runtime *accountRuntime) servePresetSave(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	body, ok := readPinnedJSONBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	name, ok := pinnedSanitizedName(nodeGet(body, "name"))
	if !ok {
		// sanitize-filename throws for a non-string name before the route's
		// truthiness check runs, so this is a 500 rather than a 400.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !jsTruthy(nodeGet(body, "preset")) || name == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directoryKey, hasFolder := pinnedPresetFolder(nodeGet(body, "apiId"))
	if !hasFolder {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	contents, err := marshalCharacterJSONIndent(nodeGet(body, "preset"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	relative, ok := runtime.presetDirectoryPath(account.string("handle"), directoryKey)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), filepath.Join(relative, name+".json"), func([]byte) ([]byte, error) {
		return contents, nil
	}); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondOrderedNodeJSON(w, http.StatusOK, orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "name", value: nodeString(name)},
	}})
}

func (runtime *accountRuntime) servePresetDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	body, ok := readPinnedJSONBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	name, ok := pinnedSanitizedName(nodeGet(body, "name"))
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if name == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directoryKey, hasFolder := pinnedPresetFolder(nodeGet(body, "apiId"))
	if !hasFolder {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	relative, ok := runtime.presetDirectoryPath(account.string("handle"), directoryKey)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	found, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), filepath.Join(relative, name+".json"))
	if err != nil {
		// unlinkSync throws for a directory target or a permission failure.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !found {
		serveStatusText(w, http.StatusNotFound)
		return
	}
	serveStatusText(w, http.StatusOK)
}

func (runtime *accountRuntime) servePresetRestore(w http.ResponseWriter, request *http.Request) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	body, ok := readPinnedJSONBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	// The pinned handler wraps everything below in one try/catch that answers
	// sendStatus(500), so a non-string name is a plain-text 500 here.
	name, ok := pinnedSanitizedName(nodeGet(body, "name"))
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	folderKey, _ := pinnedPresetFolder(nodeGet(body, "apiId"))
	result := orderedNodeJSON{kind: 'o'}
	result.setMember("isDefault", nodeBool(false))
	result.setMember("preset", nodeObject())
	for _, preset := range pinnedDefaultPresets() {
		if preset.name != name || preset.folderKey != folderKey {
			continue
		}
		presetContents, exists := pinnedDefaultPresetFile(preset.filename)
		if !exists {
			presetContents = nodeObject()
		}
		result.setMember("isDefault", nodeBool(true))
		result.setMember("preset", presetContents)
		break
	}
	respondOrderedNodeJSON(w, http.StatusOK, result)
}
