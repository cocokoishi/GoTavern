package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveUserResetSettings(w http.ResponseWriter, request *http.Request) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	state := accountFromContext(request)
	if state.user == nil {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	if nodeTruthyJSON(state.user.raw("password")) {
		var password string
		if len(input["password"]) == 0 || input["password"][0] != '"' || json.Unmarshal(input["password"], &password) != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		passwordHash, err := upstreamPasswordHash(password, state.user.string("salt"))
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if passwordHash != state.user.string("password") {
			respondJSON(w, http.StatusForbidden, map[string]string{"error": "Incorrect password"})
			return
		}
	}
	if runtime.options.DataRoot == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	handle := state.user.string("handle")
	if runtime.options.AccountsEnabled && state.session != nil {
		if sessionHandle, hasHandle := state.session.stringValue("handle"); hasHandle {
			handle = sessionHandle
		}
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, handle)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	settingsPath := filepath.Join(directories["root"], "settings.json")
	if info, err := os.Lstat(settingsPath); err == nil {
		if info.IsDir() {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if err := os.Remove(settingsPath); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// checkForNewContent() catches and logs its own errors. The pinned route
	// still returns 204 after attempting to restore the default settings file.
	_, _ = startup.SeedDefaultContent(runtime.options.DataRoot, []startup.UserDirectories{directories}, startup.SeedOptions{
		SkipContentCheck: true,
		ForceCategories:  []string{"settings"},
	})
	serveNoContent(w)
}
