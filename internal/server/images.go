package server

// Pinned /api/images/* routes, from src/endpoints/images.js:
//
//	POST /api/images/upload          images.js:39
//	POST /api/images/list/:folder?   images.js:80
//	POST /api/images/folders         images.js:115
//	POST /api/images/delete          images.js:133
//
// These four are local: they read and write the per-user `user/images` tree and answer from it. They
// are pinned by tools/probe-images.mjs (tests/oracle/sillytavern-1.19.0-images.json) by seeding one
// tree with fixed whole-second mtimes and comparing the response plus the resulting tree.
//
// Pinned details a careful implementation would get wrong, each recorded:
//
//   - an unnamed upload is named `${Date.now()}.${format}` and the response path is the CLIENT-relative
//     path with '/' separators;
//   - `ch_name` goes through sanitize-filename, so a path separator is removed rather than creating a
//     deeper tree, and `filename`'s extension is REPLACED by the requested format;
//   - the media filter is `mime.lookup` from mime-types (not mime@1.6.0, which the static path uses), so
//     an .svg counts as an image and a .txt does not; the default `type` is IMAGE and the default sort
//     field is `date`, not `name`;
//   - `folder: '.'` passes the `!folder` truthiness guard and sanitizes to '', which lists the images
//     root, while `folder: ''` answers 400;
//   - an unknown sortField falls through to readdir order, which is a filesystem property and is
//     therefore recorded sorted and classified as shape;
//   - `path.join(root, body.path)` never treats body.path as absolute, so the containment check is
//     `isPathUnderParent(userImages, joined)`;
//   - the error bodies are JSON `{error}` except for /delete, whose bodies are plain strings and whose
//     success body is sendStatus(200) = "OK".

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// mediaExtensions is the pinned MEDIA_EXTENSIONS list (src/constants.js).
var mediaExtensions = []string{
	"bmp", "png", "jpg", "webp", "jpeg", "jfif", "gif", "mp4", "avi", "mov", "wmv", "flv",
	"webm", "3gp", "mkv", "mpg", "mp3", "wav", "ogg", "flac", "aac", "m4a", "aiff",
}

// mediaRequestType mirrors MEDIA_REQUEST_TYPE (src/constants.js).
const (
	mediaRequestImage = 0b001
	mediaRequestVideo = 0b010
	mediaRequestAudio = 0b100
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerImageRoutes)
}

func registerImageRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/images/upload", accounts.serveImagesUpload)
	post("/api/images/list", func(w http.ResponseWriter, r *http.Request) { accounts.serveImagesList(w, r, "") })
	post("/api/images/list/", func(w http.ResponseWriter, r *http.Request) {
		folder := strings.TrimPrefix(r.URL.Path, "/api/images/list/")
		accounts.serveImagesList(w, r, folder)
	})
	post("/api/images/folders", accounts.serveImagesFolders)
	post("/api/images/delete", accounts.serveImagesDelete)
}

// imagesDirectories resolves the authenticated user's image tree.
func (runtime *accountRuntime) imagesDirectories(w http.ResponseWriter, request *http.Request) (startup.UserDirectories, string, bool) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return nil, "", false
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return nil, "", false
	}
	images, present := directories["userImages"]
	if !present || images == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return nil, "", false
	}
	return directories, images, true
}

// imagesJSONError answers `response.status(code).send({ error })`.
func imagesJSONError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}

// imagesBodyString reads a body member as a JavaScript string, reporting whether it was truthy.
func imagesBodyString(raw json.RawMessage) (string, bool, bool) {
	if len(raw) == 0 || !nodeTruthyJSON(raw) {
		return "", false, true
	}
	value, err := javascriptStringOfBody(raw)
	if err != nil {
		return "", false, false
	}
	return value, true, true
}

// clientRelativePathToken is `clientRelativePath(root, inputPath)`: the root is stripped and the
// separators are normalized to '/', with no leading separator added by the function itself.
func clientRelativePathToken(root, inputPath string) (string, bool) {
	if !strings.HasPrefix(inputPath, root) {
		return "", false
	}
	return strings.ReplaceAll(filepath.ToSlash(inputPath[len(root):]), "\\", "/"), true
}

// removeFileExtensionToken mirrors `filename.replace(/\.[^.]+$/, ”)`.
func removeFileExtensionToken(filename string) string {
	if dot := strings.LastIndexByte(filename, '.'); dot >= 0 && dot < len(filename)-1 {
		return filename[:dot]
	}
	return filename
}

// writeUserImageFile stores one uploaded image through the same atomic replacement used by every
// other binary user asset (avatars, thumbnails, stats).
//
// WHY THIS IS NOT os.WriteFile. An upload with an existing target name overwrites a user's image,
// and pinned's fs.writeFileSync truncates the target before writing it. A crash, a full disk or a
// killed process in that window leaves the PREVIOUS image destroyed rather than replaced; and a
// concurrent reader (the /api/images/list + static path this product serves) can observe a
// truncated file. A temp file + fsync + rename makes the target either the old image or the new
// one, never a prefix of either. The visible end state on success is unchanged.
func writeUserImageFile(target string, content []byte) error {
	return startup.WriteFileAtomic(target, content)
}

// serveImagesUpload stores a base64 image in the user images tree.
func (runtime *accountRuntime) serveImagesUpload(w http.ResponseWriter, request *http.Request) {
	directories, images, ok := runtime.imagesDirectories(w, request)
	if !ok {
		return
	}
	root := directories["root"]
	if root == "" {
		imagesJSONError(w, http.StatusInternalServerError, "Failed to save the image")
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	formatRaw, hasFormat := input["format"]
	format, isString := secretsStringValue(formatRaw)
	if !hasFormat || !isString || !isMediaExtension(format) {
		imagesJSONError(w, http.StatusBadRequest, "Invalid image format")
		return
	}
	imageRaw, hasImage := input["image"]
	if !hasImage || !nodeTruthyJSON(imageRaw) {
		imagesJSONError(w, http.StatusBadRequest, "No image data provided")
		return
	}
	imageText, imageIsString := secretsStringValue(imageRaw)
	if !imageIsString {
		// Buffer.from(nonString, 'base64') throws in the pinned handler, which its catch turns into 500.
		imagesJSONError(w, http.StatusInternalServerError, "Failed to save the image")
		return
	}
	filename := ""
	if submitted, present := input["filename"]; present && nodeTruthyJSON(submitted) {
		name, isString, valid := imagesBodyString(submitted)
		if !valid {
			imagesJSONError(w, http.StatusInternalServerError, "Failed to save the image")
			return
		}
		if isString {
			filename = removeFileExtensionToken(name) + "." + format
		}
	} else {
		filename = timestampMilliseconds() + "." + format
	}
	target := filepath.Join(images, startup.SanitizeUserFilename(filename))
	if nameRaw, present := input["ch_name"]; present && nodeTruthyJSON(nameRaw) {
		name, isString, valid := imagesBodyString(nameRaw)
		if !valid {
			imagesJSONError(w, http.StatusInternalServerError, "Failed to save the image")
			return
		}
		if isString {
			target = filepath.Join(images, startup.SanitizeUserFilename(name), startup.SanitizeUserFilename(filename))
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		imagesJSONError(w, http.StatusInternalServerError, "Failed to save the image")
		return
	}
	content, err := decodeBase64Node(imageText)
	if err != nil {
		imagesJSONError(w, http.StatusInternalServerError, "Failed to save the image")
		return
	}
	if err := writeUserImageFile(target, content); err != nil {
		imagesJSONError(w, http.StatusInternalServerError, "Failed to save the image")
		return
	}
	relative, ok := clientRelativePathToken(root, target)
	if !ok {
		imagesJSONError(w, http.StatusInternalServerError, "Failed to save the image")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"path": relative})
}

// isMediaExtension mirrors MEDIA_EXTENSIONS.includes(format).
func isMediaExtension(format string) bool {
	for _, candidate := range mediaExtensions {
		if candidate == format {
			return true
		}
	}
	return false
}

// timestampMilliseconds is `Date.now()`.
func timestampMilliseconds() string {
	return strconv.FormatInt(time.Now().UnixMilli(), 10)
}

// isJSONNull reports a raw JSON null, which the pinned `??` operator treats as absent.
func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// marshalJSONString encodes one JSON string value for a raw body member.
func marshalJSONString(value string) []byte {
	encoded, err := marshalNodeJSONString(value)
	if err != nil {
		// A Go string always encodes, so this branch is unreachable; returning a valid empty JSON
		// string keeps the failure visible as a wrong value rather than as invalid JSON downstream.
		return []byte(`""`)
	}
	return encoded
}

// serveImagesList lists the media files of one folder.
func (runtime *accountRuntime) serveImagesList(w http.ResponseWriter, request *http.Request, paramFolder string) {
	_, images, ok := runtime.imagesDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	bodyFolder, bodyFolderPresent := input["folder"]
	bodyFolderTruthy := bodyFolderPresent && nodeTruthyJSON(bodyFolder)
	if paramFolder != "" {
		if bodyFolderTruthy {
			imagesJSONError(w, http.StatusBadRequest, "Folder specified in both URL and body")
			return
		}
		// `request.body.folder = request.params.folder` — the deprecated form.
		input["folder"] = json.RawMessage(marshalJSONString(paramFolder))
		bodyFolderTruthy = true
	}
	if !bodyFolderTruthy {
		imagesJSONError(w, http.StatusBadRequest, "No folder specified")
		return
	}
	folder, isString, valid := imagesBodyString(input["folder"])
	if !valid {
		imagesJSONError(w, http.StatusInternalServerError, "Unable to retrieve files")
		return
	}
	if !isString {
		imagesJSONError(w, http.StatusInternalServerError, "Unable to retrieve files")
		return
	}
	directoryPath := filepath.Join(images, startup.SanitizeUserFilename(folder))
	requestType := float64(mediaRequestImage)
	if raw, present := input["type"]; present && !isJSONNull(raw) {
		value, err := decodeOrderedNodeJSON(raw)
		if err != nil {
			imagesJSONError(w, http.StatusInternalServerError, "Unable to retrieve files")
			return
		}
		requestType = javascriptToNumber(value)
	}
	sortField := "date"
	if raw, present := input["sortField"]; present && nodeTruthyJSON(raw) {
		if value, err := javascriptStringOfBody(raw); err == nil {
			sortField = value
		}
	}
	order := "asc"
	if raw, present := input["sortOrder"]; present && nodeTruthyJSON(raw) {
		if value, err := javascriptStringOfBody(raw); err == nil {
			order = value
		}
	}
	if info, err := os.Stat(directoryPath); errors.Is(err, fs.ErrNotExist) {
		if err := os.MkdirAll(directoryPath, 0o755); err != nil {
			imagesJSONError(w, http.StatusInternalServerError, "Unable to retrieve files")
			return
		}
	} else if err != nil {
		imagesJSONError(w, http.StatusInternalServerError, "Unable to retrieve files")
		return
	} else if !info.IsDir() {
		imagesJSONError(w, http.StatusInternalServerError, "Unable to retrieve files")
		return
	}
	files, err := mediaFiles(directoryPath, sortField, int(requestType))
	if err != nil {
		imagesJSONError(w, http.StatusInternalServerError, "Unable to retrieve files")
		return
	}
	if order == "desc" {
		for left, right := 0, len(files)-1; left < right; left, right = left+1, right-1 {
			files[left], files[right] = files[right], files[left]
		}
	}
	respondJSON(w, http.StatusOK, files)
}

// mediaFiles reproduces getImages (src/util.js:682): readdir withFileTypes, files only, filtered by
// mime.lookup's media prefix, then sorted by the requested field.
func mediaFiles(directoryPath, sortBy string, requestType int) ([]string, error) {
	entries, err := os.ReadDir(directoryPath)
	if err != nil {
		return nil, err
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		mediaType, known := pinnedUserAvatarMediaType(entry.Name())
		if !known {
			continue
		}
		if requestType&mediaRequestImage != 0 && strings.HasPrefix(mediaType, "image/") {
			files = append(files, entry.Name())
			continue
		}
		if requestType&mediaRequestVideo != 0 && strings.HasPrefix(mediaType, "video/") {
			files = append(files, entry.Name())
			continue
		}
		if requestType&mediaRequestAudio != 0 && strings.HasPrefix(mediaType, "audio/") {
			files = append(files, entry.Name())
			continue
		}
	}
	switch sortBy {
	case "name":
		// `files.sort(Intl.Collator().compare)`
		collator := collate.New(language.AmericanEnglish)
		sort.SliceStable(files, func(left, right int) bool {
			return collator.CompareString(files[left], files[right]) < 0
		})
		return files, nil
	case "date":
		mtimes := make(map[string]int64, len(files))
		for _, file := range files {
			info, err := os.Stat(filepath.Join(directoryPath, file))
			if errors.Is(err, fs.ErrNotExist) {
				mtimes[file] = 0
				continue
			}
			if err != nil {
				return nil, err
			}
			mtimes[file] = info.ModTime().UnixNano() / int64(1e6)
		}
		sort.SliceStable(files, func(left, right int) bool {
			return mtimes[files[left]]-mtimes[files[right]] < 0
		})
		return files, nil
	default:
		return files, nil
	}
}

// serveImagesFolders lists the immediate subdirectories.
func (runtime *accountRuntime) serveImagesFolders(w http.ResponseWriter, request *http.Request) {
	_, images, ok := runtime.imagesDirectories(w, request)
	if !ok {
		return
	}
	if _, err := os.Stat(images); errors.Is(err, fs.ErrNotExist) {
		if err := os.MkdirAll(images, 0o755); err != nil {
			imagesJSONError(w, http.StatusInternalServerError, "Unable to retrieve folders")
			return
		}
	} else if err != nil {
		imagesJSONError(w, http.StatusInternalServerError, "Unable to retrieve folders")
		return
	}
	entries, err := os.ReadDir(images)
	if err != nil {
		imagesJSONError(w, http.StatusInternalServerError, "Unable to retrieve folders")
		return
	}
	folders := make([]string, 0)
	for _, entry := range entries {
		if entry.IsDir() {
			folders = append(folders, entry.Name())
		}
	}
	respondJSON(w, http.StatusOK, folders)
}

// serveImagesDelete removes one file under the user images tree.
func (runtime *accountRuntime) serveImagesDelete(w http.ResponseWriter, request *http.Request) {
	directories, images, ok := runtime.imagesDirectories(w, request)
	if !ok {
		return
	}
	root := directories["root"]
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	pathRaw, hasPath := input["path"]
	if !hasPath || !nodeTruthyJSON(pathRaw) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "No path specified")
		return
	}
	submitted, isString := secretsStringValue(pathRaw)
	if !isString {
		// `path.join(root, nonString)` throws in the pinned handler, which its catch answers 500.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	pathToDelete := filepath.Join(root, submitted)
	if !isPathUnderParentToken(images, pathToDelete) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Invalid path")
		return
	}
	if _, err := os.Stat(pathToDelete); errors.Is(err, fs.ErrNotExist) {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", "File not found")
		return
	} else if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := os.Remove(pathToDelete); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}

// isPathUnderParentToken mirrors `isPathUnderParent(parentPath, childPath)`.
func isPathUnderParentToken(parentPath, childPath string) bool {
	normalizedParent := filepath.Clean(parentPath)
	normalizedChild := filepath.Clean(childPath)
	relative, err := filepath.Rel(normalizedParent, normalizedChild)
	if err != nil {
		return false
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return false
	}
	return true
}
