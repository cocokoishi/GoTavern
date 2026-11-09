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
	// The frontend revalidates this route on load; express answers 304 for a fresh request (measured pinned).
	respondJSONConditional(w, request, http.StatusOK, startup.UserSprites(runtime.options.DataRoot, account.string("handle"), name))
}
