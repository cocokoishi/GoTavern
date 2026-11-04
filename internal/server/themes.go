package server

import (
	"errors"
	"github.com/cocokoishi/gotavern/internal/httpx"
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
	if err := startup.SaveThemePreset(runtime.options.DataRoot, account.string("handle"), filename, contents); err != nil {
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return
	}
	httpx.WriteStatusText(w, http.StatusOK)
}

func (runtime *accountRuntime) serveThemeDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	_, input, ok := readUserPresetRequestBody(request)
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
	if err := startup.DeleteThemePreset(runtime.options.DataRoot, account.string("handle"), filename); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			httpx.WriteStatusText(w, http.StatusNotFound)
			return
		}
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return
	}
	httpx.WriteStatusText(w, http.StatusOK)
}
