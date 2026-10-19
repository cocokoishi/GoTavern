package server

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveQuickReplySave(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	body, input, ok := readUserPresetRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	name := input["name"]
	if !nodeTruthyJSON(name) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	filename, err := startup.UserPresetFilename(name)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	contents, err := startup.FormatSettingsJSON(body)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if err := startup.SaveQuickReplyPreset(runtime.options.DataRoot, account.string("handle"), filename, contents); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}

func (runtime *accountRuntime) serveQuickReplyDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	_, input, ok := readUserPresetRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	name := input["name"]
	if !nodeTruthyJSON(name) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	filename, err := startup.UserPresetFilename(name)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if err := startup.DeleteQuickReplyPreset(runtime.options.DataRoot, account.string("handle"), filename); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}

func readUserPresetRequestBody(request *http.Request) ([]byte, map[string]json.RawMessage, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, 500<<20))
	if err != nil {
		return nil, nil, false
	}
	input := make(map[string]json.RawMessage)
	if len(body) > 0 && json.Unmarshal(body, &input) != nil {
		return nil, nil, false
	}
	if input == nil {
		input = make(map[string]json.RawMessage)
	}
	return body, input, true
}
