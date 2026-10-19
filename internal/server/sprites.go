package server

import (
	"net/http"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveSpritesGet(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	name := "undefined"
	if values, exists := request.URL.Query()["name"]; exists {
		name = strings.Join(values, ",")
	}
	respondJSON(w, http.StatusOK, startup.UserSprites(runtime.options.DataRoot, account.string("handle"), name))
}
