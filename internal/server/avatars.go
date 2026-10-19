package server

import (
	"encoding/json"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveAvatarsGet(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	images, err := startup.UserAvatarImages(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, images)
}

func (runtime *accountRuntime) serveAvatarsDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	contentType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	input, valid := readAccountRequestBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	rawAvatar, exists := input["avatar"]
	if !exists {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if filenameFieldHasForbiddenPathCharacter(rawAvatar) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	var value any
	if err := json.Unmarshal(rawAvatar, &value); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	avatar, isString := value.(string)
	if !isString {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	filename := startup.SanitizeUserFilename(avatar)
	if avatar != filename {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	deleted, err := startup.DeleteUserAvatar(runtime.options.DataRoot, account.string("handle"), filename)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !deleted {
		serveStatusText(w, http.StatusNotFound)
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"result": "ok"})
}

func filenameFieldHasForbiddenPathCharacter(raw json.RawMessage) bool {
	var value any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || value == nil {
		return false
	}
	if object, ok := value.(map[string]any); ok {
		if _, shadowsMethod := object["toString"]; shadowsMethod {
			return false
		}
	}
	text := nodeStringForFilenameValidation(value)
	forbidden := "/\x00"
	if os.PathSeparator == '\\' {
		forbidden += "\\"
	}
	return strings.ContainsAny(text, forbidden)
}

func nodeStringForFilenameValidation(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case []any:
		parts := make([]string, len(typed))
		for index, item := range typed {
			parts[index] = nodeStringForFilenameValidation(item)
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}
