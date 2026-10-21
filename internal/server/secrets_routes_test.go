package server

// Replay of the pinned HTTP recording for the secrets domain, produced by tools/probe-secrets.mjs
// against the real pinned listener (tests/oracle/sillytavern-1.19.0-secrets.json, `httpRuns`).
//
// Every step asserts four things, which is what makes this evidence rather than a smoke test:
//
//	1. the status;
//	2. EVERY response header (content-type, content-length, weak ETag and the security headers),
//	   except an ETag that hashes a body carrying a generated uuid;
//	3. the response BYTES, not a parsed value: /view and /read both depend on key order, and a
//	   parsed comparison cannot see order;
//	4. the exact bytes of secrets.json after the step, or its absence. A mutation that writes the
//	   file when the pinned code returns early produces identical parsed JSON and different bytes,
//	   which is why the "no write" scenarios are seeded with two-space JSON.
//
// The seed/handler fidelity matches the pinned runtime: the per-user directory exists (startup
// creates it), the pinned server's config had extensions disabled, and allowKeysExposure is a
// per-boot constant.

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

type secretsOracleRun struct {
	Label             string  `json:"label"`
	AllowKeysExposure bool    `json:"allowKeysExposure"`
	InitialFile       *string `json:"initialFile"`
	Steps             []struct {
		Label    string `json:"label"`
		Route    string `json:"route"`
		Body     string `json:"body"`
		Response struct {
			Status   int               `json:"status"`
			Headers  map[string]string `json:"headers"`
			Body     json.RawMessage   `json:"body"`
			BodyText string            `json:"bodyText"`
		} `json:"response"`
		FileAfter *string `json:"fileAfter"`
	} `json:"steps"`
}

// secretUUIDPattern is the marker the probe substituted for the only nondeterministic value in this
// domain (the uuidv4 writeSecret generates). Go writes a real uuid, so the Go side is normalized the
// same way before the bytes are compared.
var secretUUIDPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`)

const secretUnstableETag = "<unstable-body>"

func normalizeSecretUUIDs(text string) string {
	return secretUUIDPattern.ReplaceAllString(text, "<uuid>")
}

// TestSecretsOracleFixtureIsDiscriminating refuses to let this test pass vacuously. Each entry names
// a recorded observation and what a fixture without it could no longer catch.
func TestSecretsOracleFixtureIsDiscriminating(t *testing.T) {
	fixture := loadSecretsOracle(t)
	var (
		statuses       = map[int]int{}
		createdFiles   int
		absentAfter    int
		noWriteCases   int
		twoSpaceSeed   int
		writeResponses int
	)
	for _, run := range fixture.HTTPRuns {
		if run.InitialFile != nil && string(*run.InitialFile) != "" && !isFourSpaceFormatted(*run.InitialFile) {
			twoSpaceSeed++
		}
		if run.InitialFile == nil {
			createdFiles++
		}
		for _, step := range run.Steps {
			statuses[step.Response.Status]++
			if step.FileAfter == nil {
				absentAfter++
			}
			if run.InitialFile != nil && step.FileAfter != nil && *step.FileAfter == *run.InitialFile {
				noWriteCases++
			}
			if step.Response.Headers["etag"] == secretUnstableETag {
				writeResponses++
			}
		}
	}
	if len(fixture.HTTPRuns) < 20 {
		t.Fatalf("the fixture records only %d scenarios; the secrets domain pinning is incomplete", len(fixture.HTTPRuns))
	}
	for _, status := range []int{200, 204, 400, 403, 404, 500} {
		if statuses[status] == 0 {
			t.Fatalf("the fixture records no %d response; that branch's handling is unproven", status)
		}
	}
	if createdFiles == 0 {
		t.Fatal("the fixture records no scenario starting from a missing secrets file, so the _ensureSecretsFile side effect is unproven")
	}
	if absentAfter == 0 {
		t.Fatal("the fixture records no step that leaves the file absent, so 'delete/rotate must not create the file' is unproven")
	}
	if twoSpaceSeed == 0 {
		t.Fatal("no scenario is seeded with two-space JSON, so a deliberate non-write is indistinguishable from a rewrite")
	}
	if noWriteCases == 0 {
		t.Fatal("no recorded step leaves the file byte-identical, so early-return behaviour is unproven")
	}
	if writeResponses == 0 {
		t.Fatal("no recorded step carries a generated uuid, so the write path is unproven")
	}
}

func isFourSpaceFormatted(content string) bool {
	return regexp.MustCompile(`\n {4}\S`).MatchString(content)
}

func TestSecretsRoutesMatchPinnedHTTPOracle(t *testing.T) {
	fixture := loadSecretsOracle(t)
	if len(fixture.HTTPRuns) == 0 {
		t.Fatal("the secrets oracle records no HTTP runs")
	}
	for _, run := range fixture.HTTPRuns {
		run := run
		t.Run(run.Label, func(t *testing.T) {
			dataRoot := t.TempDir()
			userRoot := filepath.Join(dataRoot, "default-user")
			if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
				t.Fatal(err)
			}
			secretsPath := filepath.Join(userRoot, "secrets.json")
			if run.InitialFile != nil {
				if err := os.WriteFile(secretsPath, []byte(*run.InitialFile), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
				InstallRoot:       dataRoot,
				DataRoot:          dataRoot,
				DisableCSRF:       true,
				AllowKeysExposure: run.AllowKeysExposure,
			})
			for _, step := range run.Steps {
				response := postSecretsRoute(t, handler, step.Route, step.Body)
				label := run.Label + "/" + step.Label
				if response.Code != step.Response.Status {
					t.Fatalf("%s: status = %d, want %d (body %q)", label, response.Code, step.Response.Status, response.Body.String())
				}
				headers := response.Header().Clone()
				expected := make(map[string]string, len(step.Response.Headers))
				for name, value := range step.Response.Headers {
					expected[name] = value
				}
				if expected["etag"] == secretUnstableETag {
					// The ETag hashes a body containing a generated uuid; the probe recorded the
					// marker, so only the ETag is skipped. Every other header is still compared.
					delete(expected, "etag")
					headers.Del("ETag")
				}
				assertPinnedHeaders(t, headers, expected)
				if got := normalizeSecretUUIDs(response.Body.String()); got != step.Response.BodyText {
					t.Fatalf("%s: body = %q, pinned %q", label, got, step.Response.BodyText)
				}
				gotFile, gotExists := readSecretsFileForTest(t, secretsPath)
				if step.FileAfter == nil {
					if gotExists {
						t.Fatalf("%s: the step created or left a secrets file, pinned expects none: %q", label, gotFile)
					}
					continue
				}
				if !gotExists {
					t.Fatalf("%s: secrets.json is missing, pinned expects %q", label, *step.FileAfter)
				}
				if gotFile != *step.FileAfter {
					t.Fatalf("%s: secrets.json bytes differ from pinned Node:\n got: %q\nwant: %q", label, gotFile, *step.FileAfter)
				}
			}
		})
	}
}

func readSecretsFileForTest(t *testing.T, path string) (string, bool) {
	t.Helper()
	body, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false
	}
	if err != nil {
		t.Fatal(err)
	}
	return normalizeSecretUUIDs(string(body)), true
}

// TestSecretsViewAndFindAreNotBehindTheExtensionsGuard pins the mount path: /api/secrets is mounted
// at server-startup.js:154 with no extensionsEnabledFeatureGuard, and the probe boots the pinned
// server with extensions disabled to prove it. A handler that resolves the account through the
// extensions guard answers 404 there instead of these answers.
func TestSecretsViewAndFindAreNotBehindTheExtensionsGuard(t *testing.T) {
	fixture := loadSecretsOracle(t)
	var seed string
	for _, run := range fixture.HTTPRuns {
		if run.Label == "viewAllowed" && run.InitialFile != nil {
			seed = *run.InitialFile
			break
		}
	}
	if seed == "" {
		t.Fatal("the fixture records no viewAllowed scenario")
	}
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	extensionsDisabled := false
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot:       dataRoot,
		DataRoot:          dataRoot,
		DisableCSRF:       true,
		AllowKeysExposure: true,
		ExtensionsEnabled: &extensionsDisabled,
	})
	for _, route := range []string{"/api/secrets/view", "/api/secrets/find"} {
		response := postSecretsRoute(t, handler, route, `{"key":"api_key_openai"}`)
		if response.Code != http.StatusOK {
			t.Fatalf("%s with extensions disabled: status = %d, want 200 (the secrets router is not behind the extensions guard)", route, response.Code)
		}
	}
}
