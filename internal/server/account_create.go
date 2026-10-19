package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func (runtime *accountRuntime) serveUserAdminSlugify(w http.ResponseWriter, request *http.Request) {
	if !requireAccountAdmin(w, request) {
		return
	}
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !nodeTruthyJSON(input["text"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	respondText(w, http.StatusOK, "text/html; charset=utf-8", pinnedSlugify(nodeStringForSlug(input["text"])))
}

func (runtime *accountRuntime) serveUserAdminCreate(w http.ResponseWriter, request *http.Request) {
	if !requireAccountAdmin(w, request) {
		return
	}
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !nodeTruthyJSON(input["handle"]) || !nodeTruthyJSON(input["name"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	if runtime.options.DataRoot == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	runtime.createMu.Lock()
	defer runtime.createMu.Unlock()

	keys, err := startup.NodePersistKeys(runtime.options.DataRoot, userStoragePrefix)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	handle := pinnedSlugify(nodeStringForSlug(input["handle"]))
	if handle == "" {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid handle"})
		return
	}
	for _, key := range keys {
		if strings.TrimPrefix(key, userStoragePrefix) == handle {
			respondJSON(w, http.StatusConflict, map[string]string{"error": "User already exists"})
			return
		}
	}

	saltBytes := make([]byte, 16)
	if _, err := rand.Read(saltBytes); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	salt := base64.StdEncoding.EncodeToString(saltBytes)
	password := ""
	if nodeTruthyJSON(input["password"]) {
		if err := json.Unmarshal(input["password"], &password); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		password, err = upstreamPasswordHash(password, salt)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	createdUser := struct {
		Handle   string          `json:"handle"`
		Name     json.RawMessage `json:"name"`
		Created  int64           `json:"created"`
		Password string          `json:"password"`
		Salt     string          `json:"salt"`
		Admin    bool            `json:"admin"`
		Enabled  bool            `json:"enabled"`
	}{
		Handle: handle, Name: compactJSON(input["name"]), Created: time.Now().UnixMilli(),
		Password: password, Salt: salt, Admin: nodeTruthyJSON(input["admin"]), Enabled: true,
	}
	userJSON, err := marshalNodeJSON(createdUser)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := startup.SetNodePersistRecord(runtime.options.DataRoot, userStoragePrefix+handle, userJSON); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	keys, err = startup.NodePersistKeys(runtime.options.DataRoot, userStoragePrefix)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	handles := make([]string, 0, len(keys))
	for _, key := range keys {
		handles = append(handles, strings.TrimPrefix(key, userStoragePrefix))
	}
	if err := runtime.ensureAccountDirectories(handles); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	newUserDirectories, err := startup.DirectoriesForUser(runtime.options.DataRoot, handle)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// checkForNewContent() catches and logs its own seeding failures; account
	// creation still succeeds once the account and directories are in place.
	_, _ = startup.SeedDefaultContent(runtime.options.DataRoot, []startup.UserDirectories{newUserDirectories}, startup.SeedOptions{
		SkipContentCheck: true,
		ForceCategories:  []string{"settings"},
	})
	respondJSON(w, http.StatusOK, map[string]string{"handle": handle})
}

func (runtime *accountRuntime) ensureAccountDirectories(handles []string) error {
	if runtime.options.InstallRoot != "" {
		_, err := startup.EnsureDirectories(runtime.options.InstallRoot, runtime.options.DataRoot, handles)
		return err
	}
	for _, handle := range handles {
		directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, handle)
		if err != nil {
			return err
		}
		for _, directory := range directories {
			if err := os.MkdirAll(directory, 0o777); err != nil {
				return err
			}
		}
	}
	return nil
}

func respondText(w http.ResponseWriter, status int, contentType, value string) {
	body := []byte(value)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
