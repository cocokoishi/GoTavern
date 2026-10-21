package server

// Pinned secrets routes, from src/endpoints/secrets.js:
//
//	POST /api/secrets/write    secrets.js:511
//	POST /api/secrets/read     secrets.js:529
//	POST /api/secrets/view     secrets.js:540
//	POST /api/secrets/find     secrets.js:560
//	POST /api/secrets/delete   secrets.js:588
//	POST /api/secrets/rotate   secrets.js:606
//	POST /api/secrets/rename   secrets.js:624
//	POST /api/secrets/settings secrets.js:642
//
// All eight are implemented and pinned by tools/probe-secrets.mjs through the real pinned listener
// (tests/oracle/sillytavern-1.19.0-secrets.json): status, headers, body, the resulting secrets.json
// BYTES, and the file-creation side effect. The state map and the masking are additionally pinned at
// module level by the same probe.
//
// The storage lives in one place (internal/startup/secrets_state.go, on the same ordered-JSON
// primitives the flat-secrets migration already owns), so this file contains no second
// representation of secrets.json.
//
// `allowKeysExposure` is read once from the startup options and passed down, matching the pinned
// module-level constant.
//
// Two pinned details a careful implementation would get wrong, both recorded by the probe:
//
//   - These routes are mounted at server-startup.js:154 with NO extensionsEnabledFeatureGuard. The
//     probe boots the pinned server with `extensions.enabled: false` and still gets every answer
//     below, so resolving the account through the extensions guard would answer 404 where the
//     pinned server answers a state map.
//   - /find gates on `!state[key]`, where `state` is a plain object literal. A key that exists in
//     secrets.json but is not in SECRET_KEYS is therefore absent, while an inherited
//     Object.prototype property (`constructor`, `toString`, `__proto__`, ...) is truthy and lets the
//     route through to readSecret, which answers `{value: ""}` instead of 404.

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
	post("/api/secrets/view", accounts.serveSecretsView)
	post("/api/secrets/find", accounts.serveSecretsFind)
	post("/api/secrets/delete", accounts.serveSecretsDelete)
	post("/api/secrets/rotate", accounts.serveSecretsRotate)
	post("/api/secrets/rename", accounts.serveSecretsRename)
	post("/api/secrets/settings", accounts.serveSecretsSettings)
}

// secretsDirectories mirrors `request.user.directories`. The extensions feature guard is deliberately
// NOT applied: the pinned secrets router is not behind it.
func (runtime *accountRuntime) secretsDirectories(w http.ResponseWriter, request *http.Request) (startup.UserDirectories, bool) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return nil, false
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return nil, false
	}
	return directories, true
}

// objectPrototypeSecretKeys are the own properties of Object.prototype. The pinned `!state[key]`
// check walks the prototype chain, so any of these names passes it even though the state map never
// sets them.
var objectPrototypeSecretKeys = map[string]bool{
	"constructor":          true,
	"__defineGetter__":     true,
	"__defineSetter__":     true,
	"hasOwnProperty":       true,
	"__lookupGetter__":     true,
	"__lookupSetter__":     true,
	"isPrototypeOf":        true,
	"propertyIsEnumerable": true,
	"toString":             true,
	"valueOf":              true,
	"__proto__":            true,
	"toLocaleString":       true,
}

// serveSecretsSettings answers { allowKeysExposure }.
func (runtime *accountRuntime) serveSecretsSettings(w http.ResponseWriter, request *http.Request) {
	respondJSON(w, http.StatusOK, map[string]bool{"allowKeysExposure": runtime.options.AllowKeysExposure})
}

// serveSecretsRead answers the state map: an entry for every pinned key, null when it has none.
func (runtime *accountRuntime) serveSecretsRead(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	body, err := startup.ReadSecretState(directories, runtime.options.AllowKeysExposure)
	if err != nil {
		// The pinned handler's catch answers {} rather than an error status.
		respondJSONBytes(w, http.StatusOK, []byte("{}"))
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveSecretsView answers the active raw value per key, and 403 without allowKeysExposure.
func (runtime *accountRuntime) serveSecretsView(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	if !runtime.options.AllowKeysExposure {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	body, err := startup.ReadActiveSecrets(directories)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveSecretsFind answers one raw value: { value }.
func (runtime *accountRuntime) serveSecretsFind(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	keyRaw, hasKey := input["key"]
	if !hasKey || !nodeTruthyJSON(keyRaw) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Key is required")
		return
	}
	keyID, keyIsString := secretsStringValue(keyRaw)
	if !keyIsString {
		// Known gap: the pinned code coerces a non-string truthy key through ToPropertyKey
		// ("5", "true"). The oracle does not cover it, so it is not claimed here.
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !runtime.options.AllowKeysExposure && !startup.IsExportableSecretKey(keyID) {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	present, err := startup.SecretStatePresence(directories, runtime.options.AllowKeysExposure, keyID)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// The state map has no own property for a non-SECRET_KEYS key, so only the prototype chain can
	// make `!state[key]` false there.
	if !present && !objectPrototypeSecretKeys[keyID] {
		serveStatusText(w, http.StatusNotFound)
		return
	}
	identifier, hasIdentifier, ok := secretIdentifierValue(input["id"])
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	value, err := startup.ReadSecretValue(directories, keyID, identifier, hasIdentifier)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := startup.SecretFindResponse(value)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveSecretsDelete removes one entry and answers 204.
func (runtime *accountRuntime) serveSecretsDelete(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	keyRaw, hasKey := input["key"]
	if !hasKey || !nodeTruthyJSON(keyRaw) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Key and ID are required")
		return
	}
	keyID, keyIsString := secretsStringValue(keyRaw)
	if !keyIsString {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	identifier, hasIdentifier, ok := secretIdentifierValue(input["id"])
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if err := startup.DeleteSecret(directories, keyID, identifier, hasIdentifier); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveNoContent(w)
}

// serveSecretsRotate activates one entry and answers 204.
func (runtime *accountRuntime) serveSecretsRotate(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	keyRaw, hasKey := input["key"]
	idRaw, hasID := input["id"]
	if !hasKey || !nodeTruthyJSON(keyRaw) || !hasID || !nodeTruthyJSON(idRaw) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Key and ID are required")
		return
	}
	keyID, keyIsString := secretsStringValue(keyRaw)
	if !keyIsString {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	identifier, _, ok := secretIdentifierValue(idRaw)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if err := startup.RotateSecret(directories, keyID, identifier); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveNoContent(w)
}

// serveSecretsRename relabels one entry and answers 204.
func (runtime *accountRuntime) serveSecretsRename(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	keyRaw, hasKey := input["key"]
	idRaw, hasID := input["id"]
	labelRaw, hasLabel := input["label"]
	if !hasKey || !nodeTruthyJSON(keyRaw) || !hasID || !nodeTruthyJSON(idRaw) || !hasLabel || !nodeTruthyJSON(labelRaw) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Key, ID, and label are required")
		return
	}
	keyID, keyIsString := secretsStringValue(keyRaw)
	if !keyIsString {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	identifier, _, ok := secretIdentifierValue(idRaw)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	// Only the label's truthiness is checked upstream, so its JSON type is preserved: a number is
	// written as a number.
	label, _, ok := secretIdentifierValue(labelRaw)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if err := startup.RenameSecret(directories, keyID, identifier, label); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveNoContent(w)
}

// serveSecretsWrite stores one secret and answers { id }.
//
// The pinned guard is `!key || typeof value !== 'string'` and its body text is exactly
// "Invalid key or value"; both are reproduced, including the fact that a non-string `label` is
// accepted and that an ABSENT label defaults to 'Unlabeled' while a null label is written as null.
func (runtime *accountRuntime) serveSecretsWrite(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	keyRaw, hasKey := input["key"]
	key, keyIsString := secretsStringValue(keyRaw)
	value, valueIsString := secretsStringValue(input["value"])
	if !hasKey || !nodeTruthyJSON(keyRaw) || !keyIsString || key == "" || !valueIsString {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Invalid key or value")
		return
	}
	labelRaw, labelPresent := input["label"]
	label, _, labelOK := secretIdentifierValue(labelRaw)
	if !labelOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	id, err := startup.WriteSecret(directories, key, value, label, labelPresent)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"id": id})
}

// secretIdentifierValue decodes one request-body JSON value into the storage layer's own JSON
// representation, reporting JavaScript truthiness separately because that is what the pinned guards
// test. It never creates a second representation of the value.
func secretIdentifierValue(raw json.RawMessage) (any, bool, bool) {
	value, present, err := startup.DecodeJSONValue(raw)
	if err != nil {
		return nil, false, false
	}
	return value, present && nodeTruthyJSON(raw), true
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
