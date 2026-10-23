package server

// VERTEXAI's credential layer for the CHUTES-style chat source pair: `getVertexAIAuth`
// (src/endpoints/google.js:41-82) as it is called from the shared chat transform
// (src/endpoints/backends/chat-completions.js:463-486).
//
// WHY THIS IS ITS OWN FILE. The chat source and the sibling `/api/google/*` routes share the auth CONCEPT
// but not the call: the chat path reads its secrets WITHOUT a `secret_id` argument (:52, :62), while the
// makersuite branch of the same transform passes `request.body.secret_id` (:477). Reusing google_native_tts's
// helpers would look tidy and would silently change which secret a multi-secret install resolves.
//
// THE AUTH MATRIX, exactly as pinned resolves it (:42-81):
//
//	precedence   request.body.reverse_proxy WINS over vertexai_auth_mode (:44): a proxy answer is returned
//	             before the mode is even consulted, with `Bearer ${proxy_password}` and type 'proxy'.
//	mode default `request.body.vertexai_auth_mode || 'express'` -- an empty string also means 'express' (:42).
//	express      secret `api_key_vertexai` (SECRET_KEYS.VERTEXAI, no secret_id) -> 'Bearer <key>'; a missing
//	             key THROWS 'API key is required for Vertex AI Express mode' (:52-59).
//	full         secret `vertexai_service_account` -> parse JSON -> JWT (RS256) -> OAuth access token ->
//	             'Bearer <access_token>'; see the BOUNDARY below.
//	anything     else throws 'Unsupported Vertex AI authentication mode: <mode>' (:81).
//
// THE FAILURE SHAPE IS NOT THE MAKERSUITE ONE. The chat transform catches every auth error and answers
// `400 {error:true, message:<error.message>}` (:471-474) -- a MESSAGE member, where the makersuite branch
// answers a bare `400 {error:true}` (:479-482). A shared error shape would erase that difference.
//
// NAMED BOUNDARY -- service-account 'full' mode is NOT implemented here. Pinned mints an RS256 JWT over
// `{iss: client_email, scope: cloud-platform, aud: oauth2.googleapis.com/token, iat, exp}` with the secret's
// `private_key` (google.js:89-116) and then exchanges it at `https://oauth2.googleapis.com/token`
// (:118-136, an OUTBOUND request). That is two behaviours to verify and this increment has no capture for
// either, so `pinnedVertexAIAuth` returns the pinned ERROR for full mode rather than a credential: answering
// 'express' semantics for a service-account install would send the wrong header to the wrong host, and
// answering a fabricated 'Bearer' would be a fake success. What IS ported from that mode is the pure part the
// URL shape depends on: getProjectIdFromServiceAccount (:144-155).
//
// NOT in this file: the request body (:502-667) and its prompt converter. See makersuite_chat.go.

import (
	"errors"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	// SECRET_KEYS.VERTEXAI and SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT.
	pinnedVertexAIExpressSecretKey        = "api_key_vertexai"
	pinnedVertexAIServiceAccountSecretKey = "vertexai_service_account"
	// `request.body.vertexai_auth_mode || 'express'` (:42).
	pinnedVertexAIDefaultAuthMode = "express"
	pinnedVertexAIExpressAuthMode = "express"
	pinnedVertexAIFullAuthMode    = "full"
	pinnedVertexAIProxyAuthType   = "proxy"
)

// pinnedVertexAIAuthFailure is the chat transform's catch shape for a failed authentication:
// `400 {error:true, message}` (:471-474).
type pinnedVertexAIAuthFailure struct {
	Message string
}

// Error makes the failure usable as an error without inventing a second error type.
func (failure *pinnedVertexAIAuthFailure) Error() string { return failure.Message }

type pinnedVertexAIAuthResult struct {
	AuthHeader string
	AuthType   string
	// ProjectID is set only in full mode, where the URL builder reads it from the service account.
	ProjectID string
}

// pinnedVertexAIAuthMode is `request.body.vertexai_auth_mode || 'express'`: a FALSY mode (absent, empty
// string, null, 0) selects express, which is a JS `||`, not a nullish `??`.
func pinnedVertexAIAuthMode(body orderedNodeJSON) string {
	if mode, exists := body.member("vertexai_auth_mode"); exists && pinnedJSTruthy(mode) {
		if text, isString := mode.stringValue(); isString {
			return text
		}
	}
	return pinnedVertexAIDefaultAuthMode
}

// pinnedVertexAIAuth resolves the credential exactly as getVertexAIAuth does, and returns the pinned error
// message instead of a credential when pinned would throw.
func pinnedVertexAIAuth(body orderedNodeJSON, directories startup.UserDirectories) (pinnedVertexAIAuthResult, error) {
	// reverse_proxy wins over the mode, before the mode is read (:44-49).
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		password := ""
		if member, hasPassword := body.member("proxy_password"); hasPassword {
			if text, isString := member.stringValue(); isString {
				password = text
			}
		}
		return pinnedVertexAIAuthResult{AuthHeader: "Bearer " + password, AuthType: pinnedVertexAIProxyAuthType}, nil
	}
	switch pinnedVertexAIAuthMode(body) {
	case pinnedVertexAIExpressAuthMode:
		// readSecret WITHOUT a secret_id argument -- that is the pinned call, not an omission.
		key, err := startup.ReadSecretString(directories, pinnedVertexAIExpressSecretKey)
		if err != nil {
			return pinnedVertexAIAuthResult{}, &pinnedVertexAIAuthFailure{Message: "API key is required for Vertex AI Express mode"}
		}
		if key == "" {
			return pinnedVertexAIAuthResult{}, &pinnedVertexAIAuthFailure{Message: "API key is required for Vertex AI Express mode"}
		}
		return pinnedVertexAIAuthResult{AuthHeader: "Bearer " + key, AuthType: pinnedVertexAIExpressAuthMode}, nil
	case pinnedVertexAIFullAuthMode:
		// The pure half of full mode: the project id the URL builder needs.
		serviceAccount, err := startup.ReadSecretString(directories, pinnedVertexAIServiceAccountSecretKey)
		if err != nil || serviceAccount == "" {
			return pinnedVertexAIAuthResult{}, &pinnedVertexAIAuthFailure{Message: "Service Account JSON is required for Vertex AI Full mode"}
		}
		projectID, projectErr := pinnedVertexAIProjectIDFromServiceAccount(serviceAccount)
		if projectErr != nil {
			return pinnedVertexAIAuthResult{}, &pinnedVertexAIAuthFailure{Message: "Service account authentication failed: " + projectErr.Error()}
		}
		// BOUNDARY: the JWT mint and the OAuth token exchange are not implemented (see the file comment).
		// A credential is deliberately NOT fabricated here.
		return pinnedVertexAIAuthResult{}, &pinnedVertexAIAuthFailure{
			Message: "Service account authentication failed: Vertex AI Full mode is not implemented in this build",
		}
	}
	return pinnedVertexAIAuthResult{}, &pinnedVertexAIAuthFailure{
		Message: "Unsupported Vertex AI authentication mode: " + pinnedVertexAIAuthMode(body),
	}
}

// pinnedVertexAIProjectIDFromServiceAccount is getProjectIdFromServiceAccount (google.js:144-155): the
// `project_id` member must be a non-empty string, and both rejections carry pinned's own messages.
func pinnedVertexAIProjectIDFromServiceAccount(serviceAccountJSON string) (string, error) {
	parsed, decodeErr := decodeOrderedNodeJSON([]byte(serviceAccountJSON))
	if decodeErr != nil || parsed.kind != 'o' {
		return "", errors.New("Invalid service account object")
	}
	projectID, exists := parsed.member("project_id")
	if !exists {
		return "", errors.New("Project ID not found in service account JSON")
	}
	text, isString := projectID.stringValue()
	if !isString || text == "" {
		return "", errors.New("Project ID not found in service account JSON")
	}
	return text, nil
}

// respondVertexAIAuthFailure writes the pinned catch: `400 {error:true, message}`.
func respondVertexAIAuthFailure(w http.ResponseWriter, failure error) {
	payload := nodeObject()
	payload.setMember("error", nodeBool(true))
	payload.setMember("message", nodeString(failure.Error()))
	respondOrderedNodeJSON(w, http.StatusBadRequest, payload)
}
