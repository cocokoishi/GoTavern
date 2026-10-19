package server

import (
	"encoding/json"
	"net/http"
	goruntime "runtime"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveSettingsGetSnapshots(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	snapshots, err := startup.ListSettingsSnapshots(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, snapshots)
}

func (runtime *accountRuntime) serveSettingsLoadSnapshot(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	name, valid := runtime.readSettingsSnapshotRequest(w, request)
	if !valid {
		return
	}
	if !strings.HasPrefix(name, startup.SettingsSnapshotPrefix(account.string("handle"))) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid snapshot name"})
		return
	}
	body, found, err := startup.ReadSettingsSnapshot(runtime.options.DataRoot, account.string("handle"), name)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !found {
		serveStatusText(w, http.StatusNotFound)
		return
	}
	respondText(w, http.StatusOK, "text/html; charset=utf-8", strings.ToValidUTF8(string(body), "\uFFFD"))
}

func (runtime *accountRuntime) serveSettingsMakeSnapshot(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	retention := float64(50)
	if runtime.options.SettingsBackupRetention != nil {
		retention = *runtime.options.SettingsBackupRetention
	}
	if err := startup.CreateSettingsSnapshot(runtime.options.DataRoot, account.string("handle"), retention); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveNoContent(w)
}

func (runtime *accountRuntime) serveSettingsRestoreSnapshot(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	name, valid := runtime.readSettingsSnapshotRequest(w, request)
	if !valid {
		return
	}
	if !strings.HasPrefix(name, startup.SettingsSnapshotPrefix(account.string("handle"))) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid snapshot name"})
		return
	}
	found, err := startup.RestoreSettingsSnapshot(runtime.options.DataRoot, account.string("handle"), name)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !found {
		serveStatusText(w, http.StatusNotFound)
		return
	}
	serveNoContent(w)
}

func (runtime *accountRuntime) settingsRequestAccount(w http.ResponseWriter, request *http.Request) (*storedAccount, bool) {
	account := runtime.requestAccount(accountFromContext(request))
	if account == nil {
		serveStatusText(w, http.StatusForbidden)
		return nil, false
	}
	if runtime.options.DataRoot == "" || account.string("handle") == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return nil, false
	}
	return account, true
}

func (runtime *accountRuntime) readSettingsSnapshotRequest(w http.ResponseWriter, request *http.Request) (string, bool) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return "", false
	}
	rawName := input["name"]
	if !nodeTruthyJSON(rawName) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid snapshot name"})
		return "", false
	}
	var name string
	if err := json.Unmarshal(rawName, &name); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return "", false
	}
	if strings.ContainsAny(name, "/\x00") || (goruntime.GOOS == "windows" && strings.ContainsRune(name, '\\')) {
		serveStatusText(w, http.StatusBadRequest)
		return "", false
	}
	return name, true
}
