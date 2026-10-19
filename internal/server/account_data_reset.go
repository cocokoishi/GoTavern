package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const accountResetCodeLifetime = 5 * time.Minute

func (runtime *accountRuntime) serveUserResetStep1(w http.ResponseWriter, request *http.Request) {
	state := accountFromContext(request)
	account := runtime.requestAccount(state)
	if account == nil {
		serveStatusText(w, http.StatusForbidden)
		return
	}

	ip := runtime.clientIP(request)
	if exceeded, wait := runtime.resetLimiter.exceeded(ip, time.Now()); exceeded {
		serveAccountRateLimit(w, wait, "Too many attempts. Try again later or contact your admin.")
		return
	}

	codeGenerator := runtime.options.resetCodeGenerator
	if codeGenerator == nil {
		codeGenerator = generateRecoveryCode
	}
	code, err := codeGenerator()
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	handle := account.string("handle")
	runtime.resetMu.Lock()
	runtime.resetCodes[handle] = recoveryCodeEntry{code: code, expires: time.Now().Add(accountResetCodeLifetime)}
	runtime.resetMu.Unlock()
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "%s, your account reset code is: %s\n", account.string("name"), code)
	fmt.Fprintln(os.Stdout)
	serveNoContent(w)
}

func (runtime *accountRuntime) serveUserResetStep2(w http.ResponseWriter, request *http.Request) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !nodeTruthyJSON(input["code"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	state := accountFromContext(request)
	account := runtime.requestAccount(state)
	if account == nil {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	if nodeTruthyJSON(account.raw("password")) {
		var password string
		if len(input["password"]) == 0 || input["password"][0] != '"' || json.Unmarshal(input["password"], &password) != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		passwordHash, err := upstreamPasswordHash(password, account.string("salt"))
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if passwordHash != account.string("password") {
			respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Incorrect password"})
			return
		}
	}

	ip := runtime.clientIP(request)
	if exceeded, wait := runtime.resetLimiter.exceeded(ip, time.Now()); exceeded {
		serveAccountRateLimit(w, wait, "Too many attempts. Try again later or contact your admin.")
		return
	}
	handle := account.string("handle")
	code := runtime.resetCode(handle, time.Now())
	requestCode, requestCodeIsString := jsonStringValue(input["code"])
	if !requestCodeIsString || code == "" || code != requestCode {
		allowed, wait := runtime.resetLimiter.consume(ip, time.Now())
		if !allowed {
			serveAccountRateLimit(w, wait, "Too many attempts. Try again later or contact your admin.")
			return
		}
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Incorrect code"})
		return
	}

	dataHandle := handle
	if runtime.options.AccountsEnabled && state.session != nil {
		if sessionHandle, hasHandle := state.session.stringValue("handle"); hasHandle {
			dataHandle = sessionHandle
		}
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, dataHandle)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if runtime.options.DataRoot == "" || directories["root"] == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := os.RemoveAll(directories["root"]); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	handles, err := runtime.userDirectoryHandles(dataHandle)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if _, err := startup.EnsureDirectories(runtime.options.InstallRoot, runtime.options.DataRoot, handles); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	_, _ = startup.SeedDefaultContent(runtime.options.DataRoot, []startup.UserDirectories{directories}, startup.SeedOptions{
		SkipContentCheck: runtime.options.SkipContentCheck,
	})
	runtime.resetLimiter.clear(ip)
	runtime.resetMu.Lock()
	delete(runtime.resetCodes, handle)
	runtime.resetMu.Unlock()
	serveNoContent(w)
}

func (runtime *accountRuntime) requestAccount(state accountRequestState) *storedAccount {
	if state.user != nil {
		return state.user
	}
	if !runtime.options.AccountsEnabled {
		return &runtime.defaultUser
	}
	return nil
}

func (runtime *accountRuntime) userDirectoryHandles(currentHandle string) ([]string, error) {
	keys, err := startup.NodePersistKeys(runtime.options.DataRoot, userStoragePrefix)
	if err != nil {
		return nil, err
	}
	handles := make([]string, 0, len(keys)+1)
	seen := make(map[string]struct{}, len(keys)+1)
	for _, key := range keys {
		handle := strings.TrimPrefix(key, userStoragePrefix)
		if _, err := startup.DirectoriesForUser(runtime.options.DataRoot, handle); err != nil {
			return nil, err
		}
		if _, exists := seen[handle]; !exists {
			seen[handle] = struct{}{}
			handles = append(handles, handle)
		}
	}
	if _, exists := seen[currentHandle]; !exists {
		if _, err := startup.DirectoriesForUser(runtime.options.DataRoot, currentHandle); err != nil {
			return nil, err
		}
		handles = append(handles, currentHandle)
	}
	return handles, nil
}

func (runtime *accountRuntime) resetCode(handle string, now time.Time) string {
	runtime.resetMu.Lock()
	defer runtime.resetMu.Unlock()
	entry, exists := runtime.resetCodes[handle]
	if !exists {
		return ""
	}
	if !entry.expires.After(now) {
		delete(runtime.resetCodes, handle)
		return ""
	}
	return entry.code
}

func jsonStringValue(raw json.RawMessage) (string, bool) {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}
