package server

import (
	"errors"
	"io/fs"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveThemeSave(w http.ResponseWriter, request *http.Request) {
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
	if err := startup.SaveThemePreset(runtime.options.DataRoot, account.string("handle"), filename, contents); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}

func (runtime *accountRuntime) serveThemeDelete(w http.ResponseWriter, request *http.Request) {
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
	if err := startup.DeleteThemePreset(runtime.options.DataRoot, account.string("handle"), filename); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			serveStatusText(w, http.StatusNotFound)
			return
		}
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}
