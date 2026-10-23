package server

// PLAN-level assertions for the MAKERSUITE / VERTEXAI URL and credential matrix.
//
// No capture is involved and none is needed: every case below is a URL the pinned source builds by string
// interpolation, so the oracle for it is the pinned line cited on each builder, and the discriminating
// input is a model/location/project pair that makes the shapes differ. The one difference a byte comparison
// could NOT tell apart is the api VERSION: both sources would look right for makersuite (`v1beta`) and only
// `TestGeminiVertexAIIgnoresTheConfiguredAPIVersion` catches vertex reading the config it never reads.

import (
	"strings"
	"testing"
)

// TestGeminiMakerSuiteURLShapes covers :730.
func TestGeminiMakerSuiteURLShapes(t *testing.T) {
	cases := []struct {
		name       string
		base       string
		apiVersion string
		model      string
		stream     bool
		apiKey     string
		want       string
	}{
		{
			name: "non-stream", base: "https://generativelanguage.googleapis.com", apiVersion: "v1beta",
			model: "gemini-2.5-pro", apiKey: "probe-key",
			want: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=probe-key",
		},
		{
			name: "stream appends alt=sse AFTER the key", base: "https://generativelanguage.googleapis.com", apiVersion: "v1beta",
			model: "gemini-2.5-pro", stream: true, apiKey: "probe-key",
			want: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?key=probe-key&alt=sse",
		},
		{
			name: "a reverse_proxy with a trailing slash loses exactly one", base: "https://proxy.example/", apiVersion: "v1beta",
			model: "gemini-2.5-flash", apiKey: "probe-key",
			want: "https://proxy.example/v1beta/models/gemini-2.5-flash:generateContent?key=probe-key",
		},
		{
			name: "the configured api version is used, so v1 differs from the default", base: "https://generativelanguage.googleapis.com", apiVersion: "v1",
			model: "gemini-2.5-flash", apiKey: "probe-key",
			want: "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=probe-key",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := pinnedMakerSuiteGenerateURL(testCase.base, testCase.apiVersion, testCase.model, testCase.stream, testCase.apiKey)
			if got != testCase.want {
				t.Fatalf("url = %s\nwant  %s", got, testCase.want)
			}
		})
	}
}

// TestGeminiMakerSuiteNeverAttachesTheKeyAsAHeader pins the credential PLACEMENT difference: the makersuite
// branch assigns `authHeader = 'Bearer '+apiKey` at :484 and then never attaches it, because the key travels
// in the query. An implementation that reused the vertex header path would send an Authorization header
// pinned never sends.
func TestGeminiMakerSuiteNeverAttachesTheKeyAsAHeader(t *testing.T) {
	url := pinnedMakerSuiteGenerateURL("https://generativelanguage.googleapis.com", "v1beta", "gemini-2.5-pro", false, "probe-key")
	if !strings.Contains(url, "?key=probe-key") {
		t.Fatalf("makersuite url does not carry the key as a query parameter: %s", url)
	}
	if strings.Contains(url, "Bearer") {
		t.Fatalf("makersuite url carries a bearer credential, which pinned never puts in the URL: %s", url)
	}
}

// TestGeminiVertexAIURLShapes covers the three auth modes at :687-728.
func TestGeminiVertexAIURLShapes(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{
			name: "express WITHOUT a project id builds a REGIONAL host and keeps the key in the query",
			got:  pinnedVertexAIExpressGenerateURL("gemini-2.5-pro", false, "probe-key", "", "us-central1"),
			want: "https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:generateContent?key=probe-key",
		},
		{
			name: "express WITH a project id forces the GLOBAL host even for a regional location (:696-698)",
			got:  pinnedVertexAIExpressGenerateURL("gemini-2.5-pro", false, "probe-key", "probe-project", "europe-west4"),
			want: "https://aiplatform.googleapis.com/v1/projects/probe-project/locations/europe-west4/publishers/google/models/gemini-2.5-pro:generateContent?key=probe-key",
		},
		{
			name: "express with region global and no project id",
			got:  pinnedVertexAIExpressGenerateURL("gemini-2.5-pro", true, "probe-key", "", "global"),
			want: "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?key=probe-key&alt=sse",
		},
		{
			name: "service account uses a regional host, the project path, and NO key in the URL",
			got:  pinnedVertexAIServiceAccountGenerateURL("gemini-2.5-pro", false, "probe-project", "us-central1"),
			want: "https://us-central1-aiplatform.googleapis.com/v1/projects/probe-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
		},
		{
			name: "service account streaming appends alt=sse and still no key",
			got:  pinnedVertexAIServiceAccountGenerateURL("gemini-2.5-pro", true, "probe-project", "us-central1"),
			want: "https://us-central1-aiplatform.googleapis.com/v1/projects/probe-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
		},
		{
			name: "service account in the global region drops the region prefix from the host",
			got:  pinnedVertexAIServiceAccountGenerateURL("gemini-2.5-pro", false, "probe-project", "global"),
			want: "https://aiplatform.googleapis.com/v1/projects/probe-project/locations/global/publishers/google/models/gemini-2.5-pro:generateContent",
		},
		{
			name: "proxy mode uses the reverse_proxy base and only alt=sse",
			got:  pinnedVertexAIProxyGenerateURL("https://proxy.example/", "gemini-2.5-pro", true),
			want: "https://proxy.example/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if testCase.got != testCase.want {
				t.Fatalf("url = %s\nwant  %s", testCase.got, testCase.want)
			}
		})
	}
}

// TestGeminiVertexAIIgnoresTheConfiguredAPIVersion is the difference no byte comparison would isolate: the
// makersuite builder takes an apiVersion argument because pinned reads `gemini.apiVersion`, while every
// vertex path hardcodes `v1`. An implementation that shared one builder would emit `v1beta` on the vertex
// path whenever the config said so -- a URL the provider would reject, on a host nobody re-recorded.
func TestGeminiVertexAIIgnoresTheConfiguredAPIVersion(t *testing.T) {
	for _, url := range []string{
		pinnedVertexAIProxyGenerateURL("https://proxy.example", "gemini-2.5-pro", false),
		pinnedVertexAIExpressGenerateURL("gemini-2.5-pro", false, "probe-key", "", "us-central1"),
		pinnedVertexAIExpressGenerateURL("gemini-2.5-pro", false, "probe-key", "probe-project", "us-central1"),
		pinnedVertexAIServiceAccountGenerateURL("gemini-2.5-pro", false, "probe-project", "us-central1"),
	} {
		if !strings.Contains(url, "/v1/") {
			t.Fatalf("vertex url does not use the hardcoded v1 path: %s", url)
		}
		if strings.Contains(url, "v1beta") {
			t.Fatalf("vertex url picked up the configured api version: %s", url)
		}
	}
}

// TestGeminiMakerSuiteStatusURLShape covers the makersuite status arm's own URL (:1912-1914), which is NOT
// the shared models GET: it builds the URL itself and omits `?key=` when a reverse_proxy supplies the
// credential.
func TestGeminiMakerSuiteStatusURLShape(t *testing.T) {
	cases := []struct {
		name            string
		base            string
		apiVersion      string
		apiKey          string
		hasReverseProxy bool
		want            string
	}{
		{
			name: "with a key the parameter is present", base: "https://generativelanguage.googleapis.com", apiVersion: "v1beta",
			apiKey: "probe-key",
			want:   "https://generativelanguage.googleapis.com/v1beta/models?key=probe-key",
		},
		{
			name: "a reverse_proxy with no key drops the parameter entirely", base: "https://proxy.example/", apiVersion: "v1beta",
			apiKey: "", hasReverseProxy: true,
			want: "https://proxy.example/v1beta/models",
		},
		{
			name: "no key and no proxy still builds the parameter, and the caller answers 400 before the fetch", base: "https://generativelanguage.googleapis.com", apiVersion: "v1beta",
			apiKey: "",
			want:   "https://generativelanguage.googleapis.com/v1beta/models?key=",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := pinnedMakerSuiteStatusURL(testCase.base, testCase.apiVersion, testCase.apiKey, testCase.hasReverseProxy)
			if got != testCase.want {
				t.Fatalf("url = %s\nwant  %s", got, testCase.want)
			}
		})
	}
}

// TestGeminiSeamsAreTwoLiterals pins the decision that these are TWO seams, not one: the pinned bases are
// different hosts, so a single shared seam would let a replay point one source at the other's host and still
// look green.
func TestGeminiSeamsAreTwoLiterals(t *testing.T) {
	t.Setenv(pinnedMakerSuiteSeamEnv, "")
	t.Setenv(pinnedVertexAISeamEnv, "")
	if got := pinnedMakerSuiteBaseURL(); got != "https://generativelanguage.googleapis.com" {
		t.Fatalf("makersuite seam default = %q", got)
	}
	if got := pinnedVertexAIBaseURL(); got != "https://us-central1-aiplatform.googleapis.com" {
		t.Fatalf("vertex seam default = %q", got)
	}
	if pinnedMakerSuiteBaseURL() == pinnedVertexAIBaseURL() {
		t.Fatal("the two pinned bases are identical, so one seam would be enough; the code assumes two")
	}
}
