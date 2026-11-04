package server

import (
	"github.com/cocokoishi/gotavern/internal/httpx"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveMovingUISave(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	body, input, ok := readUserPresetRequestBody(request)
	if !ok {
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return
	}
	name := input["name"]
	if !nodeTruthyJSON(name) {
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return
	}
	filename, err := startup.UserPresetFilename(name)
	if err != nil {
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return
	}
	contents, err := startup.FormatSettingsJSON(body)
	if err != nil {
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return
	}
	if err := startup.SaveMovingUIPreset(runtime.options.DataRoot, account.string("handle"), filename, contents); err != nil {
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return
	}
	httpx.WriteStatusText(w, http.StatusOK)
}
