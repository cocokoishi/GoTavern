package server

// Pinned user-data asset routes, from src/endpoints/assets.js:
//
//	POST /api/assets/get        (108)
//	POST /api/assets/delete     (269)
//	POST /api/assets/character  (315)
//
// The fixtures are tests/oracle/sillytavern-1.19.0-assets.json recorded by tools/probe-assets.mjs.
// Path separators are HOST-DEPENDENT here: the pinned routes mix clientRelativePath (always '/')
// with plain string templates (always '/') and path.join for character live2d (platform
// separator). The replay normalises both sides to '/' and the fixture classifies the separator and
// the readdir-derived ordering as `shape`.
//
// DEFERRED, recorded in the fixture knownDifferences: /api/assets/download (whitelist config plus a
// streamed write path).

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

var assetsCategories = []string{"bgm", "ambient", "blip", "live2d", "vrm", "character", "temp"}

// assetsUnsafeExtensions is UNSAFE_EXTENSIONS from src/constants.js.
var assetsUnsafeExtensions = []string{
	".php", ".exe", ".com", ".dll", ".pif", ".application", ".gadget", ".msi", ".jar", ".cmd",
	".bat", ".reg", ".sh", ".py", ".js", ".jse", ".jsp", ".pdf", ".html", ".htm", ".hta", ".vb",
	".vbs", ".vbe", ".cpl", ".msc", ".scr", ".sql", ".iso", ".img", ".dmg", ".ps1", ".ps1xml",
	".ps2", ".ps2xml", ".psc1", ".psc2", ".msh", ".msh1", ".msh2", ".mshxml", ".msh1xml",
	".msh2xml", ".scf", ".lnk", ".inf", ".doc", ".docm", ".docx", ".dot", ".dotm", ".dotx",
	".xls", ".xlsm", ".xlsx", ".xlt", ".xltm", ".xltx", ".xlam", ".ppt", ".pptm", ".pptx", ".pot",
	".potm", ".potx", ".ppam", ".ppsx", ".ppsm", ".pps", ".sldx", ".sldm", ".ws",
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerAssetsRoutes)
}

func registerAssetsRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	for _, route := range []string{"/api/assets/get", "/api/assets/delete", "/api/assets/character", "/api/assets/download"} {
		handler := map[string]func(http.ResponseWriter, *http.Request){
			"/api/assets/get":       accounts.serveAssetsGet,
			"/api/assets/delete":    accounts.serveAssetsDelete,
			"/api/assets/character": accounts.serveAssetsCharacter,
			"/api/assets/download":  accounts.serveAssetsDownload,
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

// assetsClientRelativePath is clientRelativePath (src/util.js): the path under the user root,
// always '/'-separated, retaining the leading separator because the root has no trailing one.
func assetsClientRelativePath(root, inputPath string) string {
	if !strings.HasPrefix(inputPath, root) {
		return inputPath
	}
	return strings.ReplaceAll(inputPath[len(root):], string(filepath.Separator), "/")
}

// assetsWalkFiles is getFiles: a recursive readdir that returns file paths in readdir order.
func assetsWalkFiles(directory string, files []string) []string {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return files
	}
	for _, entry := range entries {
		full := filepath.Join(directory, entry.Name())
		if entry.IsDir() {
			files = assetsWalkFiles(full, files)
		} else {
			files = append(files, full)
		}
	}
	return files
}

func assetsValidCategory(value string) (string, bool) {
	for _, category := range assetsCategories {
		if category == value {
			return category, true
		}
	}
	return "", false
}

// assetsEnsureFolders is ensureFoldersExist, run under the user content lock so a concurrent
// mutation cannot observe a half-created category.
func (runtime *accountRuntime) assetsEnsureFolders(account *storedAccount, directories startup.UserDirectories) error {
	folderPath := directories["assets"]
	return runtime.assetsWithContentLock(account, directories, func() error {
		for _, category := range assetsCategories {
			target := filepath.Join(folderPath, category)
			if info, err := os.Stat(target); err == nil && !info.IsDir() {
				if removeErr := os.Remove(target); removeErr != nil {
					return removeErr
				}
			}
			if _, err := os.Stat(target); os.IsNotExist(err) {
				if mkdirErr := os.MkdirAll(target, 0o777); mkdirErr != nil {
					return mkdirErr
				}
			}
		}
		return nil
	})
}

func (runtime *accountRuntime) assetsWithContentLock(account *storedAccount, directories startup.UserDirectories, operation func() error) error {
	anchor := filepath.Join(directories["assets"], ".gotavern-lock-anchor")
	relative, ok := sdUserRelativePath(directories, anchor)
	if !ok {
		return errAssetsLockEscapes
	}
	return startup.UpdateUserContentFileIfChanged(runtime.options.DataRoot, account.string("handle"), relative, func([]byte) ([]byte, bool, error) {
		return nil, false, operation()
	})
}

var errAssetsLockEscapes = &assetsLockError{}

type assetsLockError struct{}

func (*assetsLockError) Error() string { return "assets lock anchor escapes the user root" }

// serveAssetsGet is assets.js:108. The pinned handler catches any error and still sends whatever it
// has built so far, so the Go handler does the same rather than answering 500.
func (runtime *accountRuntime) serveAssetsGet(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	output := nodeObject()
	send := func() { searchJSON(w, output) }

	folderPath := directories["assets"]
	info, err := os.Stat(folderPath)
	if err != nil || !info.IsDir() {
		send()
		return
	}
	if err := runtime.assetsEnsureFolders(account, directories); err != nil {
		send()
		return
	}
	entries, err := os.ReadDir(folderPath)
	if err != nil {
		send()
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		folder := entry.Name()
		if folder == "temp" {
			continue
		}
		if folder == "live2d" {
			list := nodeArray()
			for _, file := range assetsWalkFiles(filepath.Join(folderPath, "live2d"), nil) {
				if strings.Contains(file, "model") && strings.HasSuffix(file, ".json") {
					list.array = append(list.array, nodeString(assetsClientRelativePath(directories["root"], file)))
				}
			}
			output.setMember(folder, list)
			continue
		}
		if folder == "vrm" {
			model := nodeArray()
			for _, file := range assetsWalkFiles(filepath.Join(folderPath, "vrm", "model"), nil) {
				if strings.HasSuffix(file, ".placeholder") {
					continue
				}
				model.array = append(model.array, nodeString(assetsClientRelativePath(directories["root"], file)))
			}
			animation := nodeArray()
			for _, file := range assetsWalkFiles(filepath.Join(folderPath, "vrm", "animation"), nil) {
				if strings.HasSuffix(file, ".placeholder") {
					continue
				}
				animation.array = append(animation.array, nodeString(assetsClientRelativePath(directories["root"], file)))
			}
			vrm := nodeObject()
			vrm.setMember("model", model)
			vrm.setMember("animation", animation)
			output.setMember("vrm", vrm)
			continue
		}
		list := nodeArray()
		files, readErr := os.ReadDir(filepath.Join(folderPath, folder))
		if readErr != nil {
			send()
			return
		}
		for _, file := range files {
			if file.Name() == ".placeholder" {
				continue
			}
			list.array = append(list.array, nodeString("assets/"+folder+"/"+file.Name()))
		}
		output.setMember(folder, list)
	}
	send()
}

// assetsValidateFileName is validateAssetFileName (assets.js:21).
//
// The pinned order matters and each branch has its own message: the regex FIRST (which allows a
// leading dot), then the unsafe-extension check, then the leading-dot check, then sanitize. An
// earlier version of this port folded the leading-dot case into the illegal-character branch, so
// `.hidden.mp3` answered the wrong message; the assets-download fixture's `download.leadingDot` step
// is what exposed it.
func assetsValidateFileName(filename string) (string, bool) {
	const illegalCharacter = "Illegal character in filename; only alphanumeric, '_', '-' are accepted."
	if filename == "" {
		return illegalCharacter, false
	}
	for _, character := range filename {
		allowed := character == '_' || character == '-' || character == '.' ||
			(character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9')
		if !allowed {
			return illegalCharacter, false
		}
	}
	extension := strings.ToLower(assetsJSExtname(filename))
	for _, unsafe := range assetsUnsafeExtensions {
		if unsafe == extension {
			return "Forbidden file extension.", false
		}
	}
	if strings.HasPrefix(filename, ".") {
		return "Filename cannot start with '.'", false
	}
	if startup.SanitizeUserFilename(filename) != filename {
		return "Reserved or long filename.", false
	}
	return "", true
}

// assetsJSExtname is node's path.extname for a name the filename guard has already accepted: the
// suffix from the last '.', and ” when the only '.' is the leading one ('.bashrc' has no extension
// in JavaScript, while Go's filepath.Ext reports the whole name).
func assetsJSExtname(name string) string {
	if base := name; strings.ContainsRune(base, '/') {
		base = base[strings.LastIndexByte(base, '/')+1:]
	}
	dot := strings.LastIndexByte(name, '.')
	if dot <= 0 {
		return ""
	}
	return name[dot:]
}

// serveAssetsDelete is assets.js:269.
func (runtime *accountRuntime) serveAssetsDelete(w http.ResponseWriter, request *http.Request) {
	account, _, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	category, categoryOK := assetsValidCategory(backendsStringMember(sdBodyMember(body, "category")))
	if !categoryOK {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	filenameNode := sdBodyMember(body, "filename")
	filename, isString := filenameNode.stringValue()
	if !isString {
		// path.extname(undefined) throws in pinned and the async route has no catch; answer 500
		// rather than terminate, the same shape used for other pinned crashes.
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if message, valid := assetsValidateFileName(filename); !valid {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", message)
		return
	}
	found, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), "assets/"+category+"/"+filename)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !found {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	backendsStatus(w, http.StatusOK)
}

// serveAssetsCharacter is assets.js:315.
func (runtime *accountRuntime) serveAssetsCharacter(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	query := request.URL.Query()
	names, present := query["name"]
	if !present {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	name := startup.SanitizeUserFilename(strings.Join(names, ","))
	categoryValue := query.Get("category")
	if values, exists := query["category"]; exists {
		categoryValue = strings.Join(values, ",")
	}
	category, categoryOK := assetsValidCategory(categoryValue)
	if !categoryOK {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	output := nodeArray()
	folderPath := filepath.Join(directories["characters"], name, category)
	if info, err := os.Stat(folderPath); err == nil && info.IsDir() {
		if category == "live2d" {
			folders, readErr := os.ReadDir(folderPath)
			if readErr != nil {
				backendsStatus(w, http.StatusInternalServerError)
				return
			}
			for _, folderInfo := range folders {
				if !folderInfo.IsDir() {
					continue
				}
				modelFolder := folderInfo.Name()
				files, fileErr := os.ReadDir(filepath.Join(folderPath, modelFolder))
				if fileErr != nil {
					backendsStatus(w, http.StatusInternalServerError)
					return
				}
				for _, file := range files {
					filename := file.Name()
					if strings.Contains(filename, "model") && strings.HasSuffix(filename, ".json") {
						output.array = append(output.array, nodeString(filepath.Join("characters", name, category, modelFolder, filename)))
					}
				}
			}
			searchJSON(w, output)
			return
		}
		files, readErr := os.ReadDir(folderPath)
		if readErr != nil {
			backendsStatus(w, http.StatusInternalServerError)
			return
		}
		for _, file := range files {
			if file.Name() == ".placeholder" {
				continue
			}
			output.array = append(output.array, nodeString("/characters/"+name+"/"+category+"/"+file.Name()))
		}
	}
	searchJSON(w, output)
}
