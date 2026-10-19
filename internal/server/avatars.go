package server

import (
	"net/http"

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
