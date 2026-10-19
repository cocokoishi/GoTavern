package server

import (
	"bytes"
	"io"
	"net/http"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const settingsSaveBodyLimit = 500 << 20

type settingsSaveThrottle struct {
	timer   *time.Timer
	pending bool
}

func (runtime *accountRuntime) serveSettingsSave(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, settingsSaveBodyLimit+1))
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if len(body) > settingsSaveBodyLimit {
		serveStatusText(w, http.StatusRequestEntityTooLarge)
		return
	}
	if len(bytes.TrimSpace(body)) == 0 {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	settings, err := startup.FormatSettingsJSON(body)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if err := runtime.saveSettings(account.string("handle"), settings); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"result": "ok"})
}

func (runtime *accountRuntime) saveSettings(handle string, settings []byte) error {
	runtime.settingsSaveMu.Lock()
	defer runtime.settingsSaveMu.Unlock()
	retention := float64(50)
	if runtime.options.SettingsBackupRetention != nil {
		retention = *runtime.options.SettingsBackupRetention
	}
	if pending, exists := runtime.settingsSaves[handle]; exists {
		saved, err := startup.SaveSettings(runtime.options.DataRoot, handle, settings, retention, false)
		if saved {
			pending.pending = true
		}
		return err
	}
	state := &settingsSaveThrottle{}
	runtime.settingsSaves[handle] = state
	saved, err := startup.SaveSettings(runtime.options.DataRoot, handle, settings, retention, true)
	if !saved {
		delete(runtime.settingsSaves, handle)
		return err
	}
	state.timer = time.AfterFunc(runtime.settingsSaveWait, func() {
		runtime.flushSettingsSave(handle, state, retention)
	})
	return err
}

func (runtime *accountRuntime) flushSettingsSave(handle string, expected *settingsSaveThrottle, retention float64) {
	runtime.settingsSaveMu.Lock()
	defer runtime.settingsSaveMu.Unlock()
	if runtime.settingsSaves[handle] != expected {
		return
	}
	if expected.pending {
		_ = startup.BackupUserSettings(runtime.options.DataRoot, handle, retention)
	}
	delete(runtime.settingsSaves, handle)
}
