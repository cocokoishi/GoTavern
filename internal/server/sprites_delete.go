package server

import (
	"encoding/json"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveSpritesDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readAccountRequestBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	name := nodeStringValue(input["name"])
	spriteName := input["spriteName"]
	if !nodeTruthyJSON(spriteName) {
		spriteName = input["label"]
	}
	if !nodeTruthyJSON(spriteName) || name == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	var targetName string
	matchName := json.Unmarshal(spriteName, &targetName) == nil
	found, err := startup.DeleteUserSpriteFiles(runtime.options.DataRoot, account.string("handle"), name, targetName, matchName)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !found {
		serveStatusText(w, http.StatusNotFound)
		return
	}
	serveStatusText(w, http.StatusOK)
}
