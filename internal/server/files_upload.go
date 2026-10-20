package server

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

var assetFilenamePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`)

var pinnedUnsafeAssetExtensions = map[string]struct{}{
	".php": {}, ".exe": {}, ".com": {}, ".dll": {}, ".pif": {}, ".application": {},
	".gadget": {}, ".msi": {}, ".jar": {}, ".cmd": {}, ".bat": {}, ".reg": {},
	".sh": {}, ".py": {}, ".js": {}, ".jse": {}, ".jsp": {}, ".pdf": {},
	".html": {}, ".htm": {}, ".hta": {}, ".vb": {}, ".vbs": {}, ".vbe": {},
	".cpl": {}, ".msc": {}, ".scr": {}, ".sql": {}, ".iso": {}, ".img": {},
	".dmg": {}, ".ps1": {}, ".ps1xml": {}, ".ps2": {}, ".ps2xml": {},
	".psc1": {}, ".psc2": {}, ".msh": {}, ".msh1": {}, ".msh2": {},
	".mshxml": {}, ".msh1xml": {}, ".msh2xml": {}, ".scf": {}, ".lnk": {},
	".inf": {}, ".doc": {}, ".docm": {}, ".docx": {}, ".dot": {},
	".dotm": {}, ".dotx": {}, ".xls": {}, ".xlsm": {}, ".xlsx": {},
	".xlt": {}, ".xltm": {}, ".xltx": {}, ".xlam": {}, ".ppt": {},
	".pptm": {}, ".pptx": {}, ".pot": {}, ".potm": {}, ".potx": {},
	".ppam": {}, ".ppsx": {}, ".ppsm": {}, ".pps": {}, ".sldx": {},
	".sldm": {}, ".ws": {},
}

func (runtime *accountRuntime) serveFilesUpload(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readFilesUploadBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	nameRaw, hasName := input["name"]
	if !hasName || !nodeTruthyJSON(nameRaw) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "No upload name specified")
		return
	}
	filename, err := validateUploadedAssetName(nameRaw)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if message := assetFilenameValidationMessage(filename); message != "" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", message)
		return
	}

	dataRaw, hasData := input["data"]
	if !hasData || !nodeTruthyJSON(dataRaw) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "No upload data specified")
		return
	}
	dataValue, err := decodeOrderedNodeJSON(dataRaw)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	dataText, err := dataValue.javascriptString()
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	content := decodeNodeBase64(dataText)
	relativePath, err := startup.SaveUserFile(runtime.options.DataRoot, account.string("handle"), filename, content)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"path": relativePath})
}

func readFilesUploadBody(request *http.Request) (map[string]json.RawMessage, bool) {
	contentType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err == nil && contentType == "application/x-www-form-urlencoded" {
		body, err := io.ReadAll(io.LimitReader(request.Body, pinnedBodyParserLimit+1))
		if err != nil || int64(len(body)) > pinnedBodyParserLimit {
			return nil, false
		}
		values, err := url.ParseQuery(string(body))
		if err != nil {
			return nil, false
		}
		input := make(map[string]json.RawMessage, len(values))
		for key, items := range values {
			var value any
			if len(items) == 1 {
				value = items[0]
			} else {
				value = items
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				return nil, false
			}
			input[key] = encoded
		}
		return input, true
	}
	return readAccountRequestBody(request)
}

func validateUploadedAssetName(raw json.RawMessage) (string, error) {
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		return "", err
	}
	filename, err := value.javascriptString()
	if err != nil {
		return "", err
	}
	if !assetFilenamePattern.MatchString(filename) {
		return filename, nil
	}
	if value.kind != 's' {
		// The pinned RegExp accepts the coerced string, then path.extname throws
		// when given the original non-string value.
		return "", errors.New("path.extname requires a string")
	}
	return filename, nil
}

func assetFilenameValidationMessage(filename string) string {
	if !assetFilenamePattern.MatchString(filename) {
		return "Illegal character in filename; only alphanumeric, '_', '-' are accepted."
	}
	if _, unsafe := pinnedUnsafeAssetExtensions[strings.ToLower(path.Ext(filename))]; unsafe {
		return "Forbidden file extension."
	}
	if strings.HasPrefix(filename, ".") {
		return "Filename cannot start with '.'"
	}
	if startup.SanitizeUserFilename(filename) != filename {
		return "Reserved or long filename."
	}
	return ""
}
