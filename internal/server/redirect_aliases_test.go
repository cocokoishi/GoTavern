package server

// Replay of the pinned deprecated redirect aliases.
//
// THE ORACLE IS A PINNED CAPTURE, NOT A RETYPED TABLE: tests/oracle/sillytavern-1.19.0-redirect-aliases.json
// is produced by tools/probe-redirect-aliases.mjs, which parses the 50 `redirect(src, destination)` calls out
// of the pinned src/server-startup.js and then drives the pinned server for every one of them, so the table
// in redirect_aliases.go and the fixture are compared against each other rather than one being copied from
// the other.
//
// Each case compares the response STATUS, every header the pinned capture recorded (Location, content-type,
// content-length, Vary, ETag, the helmet set), the body BYTES by digest, and the deprecation console.warn
// line. The 404 cases matter as much as the 308s: they prove the mount is a SEGMENT PREFIX and not a
// generous string prefix (`/createcharacterx` must not redirect, `/listimgfiles/` must not redirect), which
// is the failure a `strings.HasPrefix` implementation would ship.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type redirectAliasFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Aliases []struct {
		Source      string `json:"source"`
		Destination string `json:"destination"`
		Line        int    `json:"line"`
	} `json:"aliases"`
	Cases []struct {
		Name    string `json:"name"`
		Request struct {
			Method string `json:"method"`
			Path   string `json:"path"`
			Query  string `json:"query"`
			Accept string `json:"accept"`
		} `json:"request"`
		Status     int               `json:"status"`
		Headers    map[string]string `json:"headers"`
		Body       json.RawMessage   `json:"body"`
		BodySha256 string            `json:"bodySha256"`
		Warnings   []string          `json:"warnings"`
	} `json:"cases"`
	BootOutbound []json.RawMessage `json:"bootOutbound"`
}

func loadRedirectAliasFixture(t *testing.T) redirectAliasFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-redirect-aliases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture redirectAliasFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Aliases) != 50 {
		t.Fatalf("fixture records %d aliases, want the pinned 50", len(fixture.Aliases))
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("fixture has no cases; a replay with nothing to replay proves nothing")
	}
	if len(fixture.BootOutbound) != 0 {
		t.Fatalf("the pinned recording boot made %d outbound request(s); a redirect probe must be egress-free", len(fixture.BootOutbound))
	}
	return fixture
}

// TestDeprecatedRedirectAliasesMatchPinnedOracle is the executed evidence behind the alias table in
// redirect_aliases.go. AGENTS.md rule 54: the registrations are EXECUTED here, not compared as spellings --
// every case goes through the real http.Handler, so a pattern net/http rejects panics in the test.
func TestDeprecatedRedirectAliasesMatchPinnedOracle(t *testing.T) {
	fixture := loadRedirectAliasFixture(t)

	var warnings bytes.Buffer
	options := HTTPHandlerOptions{DataRoot: t.TempDir(), DisableCSRF: true}
	options.redirectWarnings = &warnings
	handler := NewHTTPHandlerWithOptions(options)

	replayed := 0
	for _, capture := range fixture.Cases {
		warnings.Reset()
		target := capture.Request.Path
		if capture.Request.Query != "" {
			target += "?" + capture.Request.Query
		}
		var body *strings.Reader
		if capture.Request.Method == http.MethodPost {
			body = strings.NewReader(`{"probe":1}`)
		} else {
			body = strings.NewReader("")
		}
		request := httptest.NewRequest(capture.Request.Method, target, body)
		if capture.Request.Accept != "" {
			request.Header.Set("Accept", capture.Request.Accept)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		if recorder.Code != capture.Status {
			t.Fatalf("%s: status = %d, pinned %d", capture.Name, recorder.Code, capture.Status)
		}
		for name, want := range capture.Headers {
			got := recorder.Header().Get(name)
			if !strings.EqualFold(got, want) {
				t.Fatalf("%s: header %q = %q, pinned %q", capture.Name, name, got, want)
			}
		}
		digest := sha256.Sum256(recorder.Body.Bytes())
		if got := hex.EncodeToString(digest[:]); got != capture.BodySha256 {
			t.Fatalf("%s: body digest = %s, pinned %s (body %q)", capture.Name, got, capture.BodySha256, recorder.Body.String())
		}
		gotWarnings := splitNonEmptyLines(warnings.String())
		if strings.Join(gotWarnings, "\n") != strings.Join(capture.Warnings, "\n") {
			t.Fatalf("%s: deprecation warnings = %q, pinned %q", capture.Name, gotWarnings, capture.Warnings)
		}
		replayed++
	}
	if replayed != len(fixture.Cases) {
		t.Fatalf("replayed %d cases of %d", replayed, len(fixture.Cases))
	}

	// The mapping itself: every pinned pair is registered by the table under test, and the table has no
	// extra row. The GET case for each alias carries the pinned Location, so this is asserted on an
	// EXECUTED response rather than by reading the Go literal.
	for _, alias := range fixture.Aliases {
		capture := findRedirectCase(t, fixture, "alias#"+alias.Source+"#GET")
		if capture.Status != http.StatusPermanentRedirect {
			t.Fatalf("%s: recorded status %d, want 308", alias.Source, capture.Status)
		}
		if got := capture.Headers["location"]; got != alias.Destination {
			t.Fatalf("%s: recorded Location = %q, pinned declaration %q", alias.Source, got, alias.Destination)
		}
	}
	if len(registeredRedirectAliasSources()) != len(fixture.Aliases) {
		t.Fatalf("the Go table has %d aliases, pinned %d", len(registeredRedirectAliasSources()), len(fixture.Aliases))
	}
	for _, alias := range fixture.Aliases {
		if _, present := registeredRedirectAliasSources()[alias.Source]; !present {
			t.Fatalf("pinned alias %s -> %s has no Go registration", alias.Source, alias.Destination)
		}
	}
}

// registeredRedirectAliasSources exposes the table the registrar is built from, so the test can assert the
// Go side has no extra or missing row without duplicating the destination map. It is read from the SAME
// slice the registrar iterates; see redirectAliasTable.
func registeredRedirectAliasSources() map[string]struct{} {
	sources := make(map[string]struct{}, len(redirectAliasTable))
	for _, alias := range redirectAliasTable {
		sources[alias.source] = struct{}{}
	}
	return sources
}

func findRedirectCase(t *testing.T, fixture redirectAliasFixture, name string) struct {
	Name    string `json:"name"`
	Request struct {
		Method string `json:"method"`
		Path   string `json:"path"`
		Query  string `json:"query"`
		Accept string `json:"accept"`
	} `json:"request"`
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	Body       json.RawMessage   `json:"body"`
	BodySha256 string            `json:"bodySha256"`
	Warnings   []string          `json:"warnings"`
} {
	t.Helper()
	for _, capture := range fixture.Cases {
		if capture.Name == name {
			return capture
		}
	}
	t.Fatalf("fixture has no case %q", name)
	panic("unreachable")
}

func splitNonEmptyLines(text string) []string {
	lines := make([]string, 0, 2)
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}
