package server

// Pinned secrets routes, from src/endpoints/secrets.js:
//
//	POST /api/secrets/write    secrets.js:511
//	POST /api/secrets/read     secrets.js:529
//	POST /api/secrets/settings secrets.js:642
//
// P1 scope: the three routes the frontend needs at startup and for a send. The other five
// (view/find/delete/rotate/rename) follow with their own recorded responses.
//
// The state map and the masking are pinned by tools/probe-secrets.mjs and by
// tests/oracle/sillytavern-1.19.0-secrets.json, and the storage lives in one place
// (internal/startup/secrets_state.go, on the same ordered-JSON primitives the flat-secrets
// migration already owns), so this file contains no second representation of secrets.json.
//
// `allowKeysExposure` is read once from the startup options and passed down, matching the pinned
// module-level constant: the probe records that the pinned util refuses to change the config path
// after it is set, so a running process cannot flip the flag either.

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerSecretsRoutes)
}

func registerSecretsRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/secrets/write", accounts.serveSecretsWrite)
	post("/api/secrets/read", accounts.serveSecretsRead)
	post("/api/secrets/settings", accounts.serveSecretsSettings)
}

// serveSecretsSettings answers { allowKeysExposure }.
func (runtime *accountRuntime) serveSecretsSettings(w http.ResponseWriter, request *http.Request) {
	respondJSON(w, http.StatusOK, map[string]bool{"allowKeysExposure": runtime.options.AllowKeysExposure})
}

// serveSecretsRead answers the state map: an entry for every pinned key, null when it has none.
func (runtime *accountRuntime) serveSecretsRead(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	body, err := startup.ReadSecretState(directories, runtime.options.AllowKeysExposure)
	if err != nil {
		// The pinned handler's catch answers {} rather than an error status.
		respondJSON(w, http.StatusOK, map[string]any{})
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveSecretsWrite stores one secret and answers { id }.
//
// The pinned guard is `!key || typeof value !== 'string'` and its body text is exactly
// "Invalid key or value"; both are reproduced, including the fact that a non-string `label` is
// accepted.
func (runtime *accountRuntime) serveSecretsWrite(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.extensionAccount(w, request)
	if !ok {
		return
	}
	body, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	_ = body
	key, keyIsString := secretsStringValue(input["key"])
	value, valueIsString := secretsStringValue(input["value"])
	if !keyIsString || key == "" || !valueIsString {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Invalid key or value")
		return
	}
	label, labelIsString := secretsStringValue(input["label"])
	if !labelIsString {
		label = "Unnamed"
	}
	id, err := startup.WriteSecret(directories, key, value, label)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"id": id})
}

// secretsStringValue reports a JSON string member, mirroring `typeof value === 'string'`.
func secretsStringValue(raw []byte) (string, bool) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

// respondJSONBytes writes an already-serialized JSON body with the same headers respondJSON sets,
// so a pre-marshalled ordered object keeps its pinned key order.
func respondJSONBytes(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
