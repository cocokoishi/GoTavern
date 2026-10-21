package server

// Pinned sprite upload routes, from src/endpoints/sprites.js:
//
//	POST /api/sprites/upload      (239)
//	POST /api/sprites/upload-zip  (186)
//
// The global upload middleware is `multer({ dest }).single('avatar')` (server-main.js:269), so the
// file part is named "avatar" and everything else arrives as text fields. Neither route needs a
// provider or an image codec: getImageBuffers (src/util.js) only unzips entries whose mime is
// image/* and whose name does not start with __MACOSX, keeping [basename, bytes].
//
// Evidence: tools/probe-sprites.mjs records tests/oracle/sillytavern-1.19.0-sprites.json from the
// pinned server (multipart parts in order with per-part headers, deterministic store-only zip) and
// internal/server/sprites_upload_test.go replays it, comparing the response and the whole
// characters tree. Writes run under the user content lock and are atomic (temp file + rename).

import (
	"archive/zip"
	"bytes"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerSpritesUploadRoutes)
}

func registerSpritesUploadRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	for _, route := range []string{"/api/sprites/upload", "/api/sprites/upload-zip"} {
		handler := map[string]func(http.ResponseWriter, *http.Request){
			"/api/sprites/upload":     accounts.serveSpritesUpload,
			"/api/sprites/upload-zip": accounts.serveSpritesUploadZip,
		}[route]
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
}

// spritesNodeParse is Node's path.parse for a basename: name and extension split at the last dot,
// with a leading dot counting as part of the name and no extension.
func spritesNodeParse(filename string) (string, string) {
	index := strings.LastIndexByte(filename, '.')
	if index <= 0 {
		return filename, ""
	}
	return filename[:index], filename[index:]
}

// spritesMultipart is the parsed multipart request: the "avatar" file part (in order) and the text
// fields, which are read by name regardless of order like multer does.
type spritesMultipart struct {
	filename    string
	fileBytes   []byte
	hasFile     bool
	fields      map[string]string
	parseFailed bool
}

func spritesParseMultipart(request *http.Request) spritesMultipart {
	result := spritesMultipart{fields: map[string]string{}}
	reader, err := request.MultipartReader()
	if err != nil {
		result.parseFailed = true
		return result
	}
	for {
		part, partErr := reader.NextPart()
		if partErr == io.EOF {
			break
		}
		if partErr != nil {
			result.parseFailed = true
			return result
		}
		formName := part.FormName()
		if part.FileName() != "" {
			if formName == "avatar" && !result.hasFile {
				content, readErr := io.ReadAll(io.LimitReader(part, 500<<20))
				if readErr != nil {
					result.parseFailed = true
					return result
				}
				result.hasFile = true
				result.filename = part.FileName()
				result.fileBytes = content
			}
			continue
		}
		value, readErr := io.ReadAll(io.LimitReader(part, 500<<20))
		if readErr != nil {
			result.parseFailed = true
			return result
		}
		if utf8.Valid(value) {
			result.fields[formName] = string(value)
		}
	}
	return result
}

// spritesResolvePath is getSpritesPath. The returned bool is false when the name sanitizes away.
func spritesResolvePath(directories startup.UserDirectories, name string) (string, bool) {
	if strings.Contains(name, "/") {
		parts := strings.Split(name, "/")
		characterName := startup.SanitizeUserFilename(parts[0])
		subfolderName := ""
		if len(parts) > 1 {
			subfolderName = startup.SanitizeUserFilename(parts[1])
		}
		if characterName == "" || subfolderName == "" {
			return "", false
		}
		return filepath.Join(directories["characters"], characterName, subfolderName), true
	}
	sanitized := startup.SanitizeUserFilename(name)
	if sanitized == "" {
		return "", false
	}
	return filepath.Join(directories["characters"], sanitized), true
}

func (runtime *accountRuntime) spritesWithContentLock(account *storedAccount, directories startup.UserDirectories, operation func() error) error {
	anchor := filepath.Join(directories["characters"], ".gotavern-sprites-lock-anchor")
	relative, ok := sdUserRelativePath(directories, anchor)
	if !ok {
		return errSpritesLockEscapes
	}
	return startup.UpdateUserContentFileIfChanged(runtime.options.DataRoot, account.string("handle"), relative, func([]byte) ([]byte, bool, error) {
		return nil, false, operation()
	})
}

var errSpritesLockEscapes = &spritesLockError{}

type spritesLockError struct{}

func (*spritesLockError) Error() string { return "sprites lock anchor escapes the user root" }

// spritesEnsureDirectory mirrors the pinned exists/mkdir/stat sequence. A path that exists but is
// not a directory answers 404 at the caller.
func spritesEnsureDirectory(target string) (directory bool, err error) {
	info, statErr := os.Stat(target)
	if statErr == nil {
		return info.IsDir(), nil
	}
	if !os.IsNotExist(statErr) {
		return false, statErr
	}
	if mkdirErr := os.MkdirAll(target, 0o777); mkdirErr != nil {
		return false, mkdirErr
	}
	return true, nil
}

func spritesAtomicWrite(target string, content []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(target), ".gotavern-sprite-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, writeErr := temporary.Write(content); writeErr != nil {
		temporary.Close()
		return writeErr
	}
	if syncErr := temporary.Sync(); syncErr != nil {
		temporary.Close()
		return syncErr
	}
	if closeErr := temporary.Close(); closeErr != nil {
		return closeErr
	}
	return os.Rename(temporaryName, target)
}

// serveSpritesUpload is sprites.js:239.
func (runtime *accountRuntime) serveSpritesUpload(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	parsed := spritesParseMultipart(request)
	if parsed.parseFailed {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	label := parsed.fields["label"]
	labelTruthy := label != ""
	// `String(request.body.name)` turns an absent field into "undefined"; only an explicitly empty
	// value is falsy, which is why a request without a name still succeeds in pinned.
	name := "undefined"
	if value, exists := parsed.fields["name"]; exists {
		name = value
	}
	if !parsed.hasFile || !labelTruthy || name == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	spriteName := parsed.fields["spriteName"]
	if spriteName == "" {
		spriteName = label
	}
	spritesPath, valid := spritesResolvePath(directories, name)
	if !valid {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	_, extension := spritesNodeParse(parsed.filename)
	filename := startup.SanitizeUserFilename(spriteName + extension)
	writeErr := runtime.spritesWithContentLock(account, directories, func() error {
		isDirectory, ensureErr := spritesEnsureDirectory(spritesPath)
		if ensureErr != nil {
			return ensureErr
		}
		if !isDirectory {
			return errSpritesNotDirectory
		}
		entries, readErr := os.ReadDir(spritesPath)
		if readErr != nil {
			return readErr
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			parsedName, _ := spritesNodeParse(entry.Name())
			if parsedName == spriteName {
				if removeErr := os.Remove(filepath.Join(spritesPath, entry.Name())); removeErr != nil {
					return removeErr
				}
			}
		}
		return spritesAtomicWrite(filepath.Join(spritesPath, filename), parsed.fileBytes)
	})
	if writeErr == errSpritesNotDirectory {
		backendsStatus(w, http.StatusNotFound)
		return
	}
	if writeErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	searchJSON(w, nodeObjectWith("ok", nodeBool(true)))
}

var errSpritesNotDirectory = &spritesNotDirectoryError{}

type spritesNotDirectoryError struct{}

func (*spritesNotDirectoryError) Error() string { return "sprites path is not a directory" }

// spritesZipImages is getImageBuffers: image entries in archive order, __MACOSX skipped, names cut
// to their basename.
func spritesZipImages(content []byte) ([][2][]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return nil, err
	}
	images := make([][2][]byte, 0, len(reader.File))
	for _, entry := range reader.File {
		if strings.HasPrefix(entry.Name, "__MACOSX") {
			continue
		}
		mimeType := mime.TypeByExtension(filepath.Ext(entry.Name))
		if !strings.HasPrefix(mimeType, "image/") {
			continue
		}
		stream, openErr := entry.Open()
		if openErr != nil {
			return nil, openErr
		}
		data, readErr := io.ReadAll(stream)
		stream.Close()
		if readErr != nil {
			return nil, readErr
		}
		images = append(images, [2][]byte{[]byte(path.Base(entry.Name)), data})
	}
	return images, nil
}

// serveSpritesUploadZip is sprites.js:186.
func (runtime *accountRuntime) serveSpritesUploadZip(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	parsed := spritesParseMultipart(request)
	if parsed.parseFailed {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	name := "undefined"
	if value, exists := parsed.fields["name"]; exists {
		name = value
	}
	if !parsed.hasFile || name == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	spritesPath, valid := spritesResolvePath(directories, name)
	if !valid {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	images, zipErr := spritesZipImages(parsed.fileBytes)
	if zipErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	writeErr := runtime.spritesWithContentLock(account, directories, func() error {
		isDirectory, ensureErr := spritesEnsureDirectory(spritesPath)
		if ensureErr != nil {
			return ensureErr
		}
		if !isDirectory {
			return errSpritesNotDirectory
		}
		existing, readErr := os.ReadDir(spritesPath)
		if readErr != nil {
			return readErr
		}
		for _, image := range images {
			filename := string(image[0])
			parsedName, _ := spritesNodeParse(filename)
			for _, entry := range existing {
				if entry.IsDir() {
					continue
				}
				existingName, _ := spritesNodeParse(entry.Name())
				if existingName == parsedName {
					if removeErr := os.Remove(filepath.Join(spritesPath, entry.Name())); removeErr != nil {
						return removeErr
					}
				}
			}
			safeName := startup.SanitizeUserFilename(filename)
			if writeErr := spritesAtomicWrite(filepath.Join(spritesPath, safeName), image[1]); writeErr != nil {
				return writeErr
			}
		}
		return nil
	})
	if writeErr == errSpritesNotDirectory {
		backendsStatus(w, http.StatusNotFound)
		return
	}
	if writeErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	payload := nodeObject()
	payload.setMember("ok", nodeBool(true))
	payload.setMember("count", nodeNumber(float64(len(images))))
	searchJSON(w, payload)
}
