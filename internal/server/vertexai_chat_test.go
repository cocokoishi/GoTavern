package server

// PLAN-level assertions for VERTEXAI's credential matrix (google.js:41-82 as called from
// chat-completions.js:463-486). No capture is involved: every case is a decision the pinned function takes
// from the request body and two named secrets, so the oracle is those lines and the discriminating input is
// a body/secret pair that makes two branches disagree.

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// geminiAuthDirectories builds a user directory set with the given secrets written through the same
// startup API the secret routes use, so the test cannot pass against a hand-made file layout the product
// would never produce.
func geminiAuthDirectories(t *testing.T, secrets map[string]string) startup.UserDirectories {
	t.Helper()
	runtimeRoot := t.TempDir()
	dataRoot := runtimeRoot + "/data"
	installRoot := runtimeRoot + "/install"
	if _, err := startup.InitializeUserStorage(dataRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range secrets {
		if _, err := startup.WriteSecret(directories, key, value, nil, false); err != nil {
			t.Fatalf("write secret %s: %v", key, err)
		}
	}
	return directories
}

// TestVertexAIAuthMatrix is the auth-precedence table: one case per pinned branch, each with the input that
// makes it distinguishable from its neighbours.
func TestVertexAIAuthMatrix(t *testing.T) {
	serviceAccount := `{"project_id":"probe-project","client_email":"probe@example.invalid"}`
	cases := []struct {
		name     string
		body     string
		secrets  map[string]string
		header   string
		authType string
		message  string
	}{
		{
			name:    "reverse_proxy wins over the mode and over the express secret",
			body:    `{"chat_completion_source":"vertexai","vertexai_auth_mode":"express","reverse_proxy":"https://proxy.example","proxy_password":"proxy-pass"}`,
			secrets: map[string]string{pinnedVertexAIExpressSecretKey: "express-key"},
			header:  "Bearer proxy-pass", authType: pinnedVertexAIProxyAuthType,
		},
		{
			name:    "reverse_proxy wins even when the mode is full",
			body:    `{"reverse_proxy":"https://proxy.example","proxy_password":"proxy-pass","vertexai_auth_mode":"full"}`,
			secrets: map[string]string{pinnedVertexAIServiceAccountSecretKey: serviceAccount},
			header:  "Bearer proxy-pass", authType: pinnedVertexAIProxyAuthType,
		},
		{
			name:    "an absent mode is express",
			body:    `{}`,
			secrets: map[string]string{pinnedVertexAIExpressSecretKey: "express-key"},
			header:  "Bearer express-key", authType: pinnedVertexAIExpressAuthMode,
		},
		{
			name:    "an empty-string mode is express too (a JS ||, not ??)",
			body:    `{"vertexai_auth_mode":""}`,
			secrets: map[string]string{pinnedVertexAIExpressSecretKey: "express-key"},
			header:  "Bearer express-key", authType: pinnedVertexAIExpressAuthMode,
		},
		{
			name:    "express without the secret throws the pinned message",
			body:    `{"vertexai_auth_mode":"express"}`,
			message: "API key is required for Vertex AI Express mode",
		},
		{
			name:    "full without the service account throws the pinned message",
			body:    `{"vertexai_auth_mode":"full"}`,
			message: "Service Account JSON is required for Vertex AI Full mode",
		},
		{
			name:    "full with a service account is the NAMED BOUNDARY, not a fabricated credential",
			body:    `{"vertexai_auth_mode":"full"}`,
			secrets: map[string]string{pinnedVertexAIServiceAccountSecretKey: serviceAccount},
			message: "Service account authentication failed: Vertex AI Full mode is not implemented in this build",
		},
		{
			name:    "an unknown mode throws the pinned unsupported message",
			body:    `{"vertexai_auth_mode":"something-else"}`,
			message: "Unsupported Vertex AI authentication mode: something-else",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			directories := geminiAuthDirectories(t, testCase.secrets)
			result, err := pinnedVertexAIAuth(decodeChutesBody(t, testCase.body), directories)
			if testCase.message != "" {
				if err == nil {
					t.Fatalf("expected the pinned failure %q, got header %q type %q", testCase.message, result.AuthHeader, result.AuthType)
				}
				if err.Error() != testCase.message {
					t.Fatalf("failure = %q\nwant     %q", err.Error(), testCase.message)
				}
				if result.AuthHeader != "" {
					t.Fatalf("a failed authentication still returned a credential %q; a fabricated header would send the wrong secret", result.AuthHeader)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected failure: %v", err)
			}
			if result.AuthHeader != testCase.header || result.AuthType != testCase.authType {
				t.Fatalf("auth = %q type %q\nwant   %q type %q", result.AuthHeader, result.AuthType, testCase.header, testCase.authType)
			}
		})
	}
}

// TestVertexAIProjectIDFromServiceAccount covers the pure half of full mode (google.js:144-155).
func TestVertexAIProjectIDFromServiceAccount(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		want    string
		message string
	}{
		{name: "a project id is returned", json: `{"project_id":"probe-project","private_key":"ignored"}`, want: "probe-project"},
		{name: "a missing member is rejected with the pinned message", json: `{"client_email":"probe@example.invalid"}`, message: "Project ID not found in service account JSON"},
		{name: "an empty string is rejected", json: `{"project_id":""}`, message: "Project ID not found in service account JSON"},
		{name: "a non-string is rejected", json: `{"project_id":42}`, message: "Project ID not found in service account JSON"},
		{name: "invalid JSON is the invalid-object message", json: `not json`, message: "Invalid service account object"},
		{name: "a non-object is the invalid-object message", json: `[1,2,3]`, message: "Invalid service account object"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := pinnedVertexAIProjectIDFromServiceAccount(testCase.json)
			if testCase.message != "" {
				if err == nil || err.Error() != testCase.message {
					t.Fatalf("failure = %v\nwant      %q", err, testCase.message)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected failure: %v", err)
			}
			if got != testCase.want {
				t.Fatalf("project id = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestVertexAIAuthFailureShape pins the chat transform's catch shape (:471-474), which differs from the
// makersuite 400: it carries a `message` member, in that order.
func TestVertexAIAuthFailureShape(t *testing.T) {
	recorder := httptest.NewRecorder()
	respondVertexAIAuthFailure(recorder, &pinnedVertexAIAuthFailure{Message: "API key is required for Vertex AI Express mode"})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	want := `{"error":true,"message":"API key is required for Vertex AI Express mode"}`
	if got := recorder.Body.String(); got != want {
		t.Fatalf("body = %s\nwant   %s", got, want)
	}
	if contentType := recorder.Header().Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Fatalf("content type = %q", contentType)
	}
}
