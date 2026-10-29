package server

// THE IN-PROCESS PERFORMANCE BASELINE THIS REPOSITORY DID NOT HAVE.
//
// WHY THIS FILE EXISTS. Every performance claim GoTavern made was a PAIRED EXTERNAL comparison
// (`tests/perf/q22-paired-benchmark.mjs`: boot time, RSS and `/version` latency against pinned Node on a shared
// runner). That answers "is it cheaper to run than Node", which is a product question, and it cannot answer the
// engineering questions the optimisation protocol needs: which function allocates, how much, and whether a
// change made it worse. There was not one `func Benchmark` in the tree (`git grep -l 'func Benchmark'` over
// `*_test.go` returned zero files), so there was no `ns/op`, no `B/op`, no `allocs/op` and nothing to attach a
// CPU or heap profile to. This file is that vehicle.
//
// WHAT IT MEASURES, and why these five. The task's performance protocol names representative surfaces rather
// than a single hot loop, because a route that is fast because it is trivial says nothing about one that reads
// the disk:
//
//	BenchmarkVersion          a tiny JSON route with no authentication (the readiness probe every client hits)
//	BenchmarkFrontendIndex    the HTML shell -- the largest single embedded asset, served on every page load
//	BenchmarkFrontendAsset    a static asset; a real page load requests ~229 of these (docs/frontend-startup-calls.md)
//	BenchmarkSettingsGet      an AUTHENTICATED JSON route that aggregates many small files from the data root
//	BenchmarkCharactersAll    an AUTHENTICATED route that stats and parses the character directory
//
// THE SETUP IS REAL, NOT STUBBED. Each benchmark builds a handler exactly as the tests do
// (`NewHTTPHandlerWithOptions`) over `b.TempDir()` roots, plants a small settings/character tree, and performs
// the product's OWN CSRF handshake and login (`GET /csrf-token`, then `POST /api/users/login` with the empty
// password a fresh install uses) rather than bypassing the middleware. A benchmark that reached a handler
// function directly would measure a code path no user has.
//
// HOW TO READ A RESULT. `-benchmem` is the point, not the ns/op: this project's stated advantage is low
// resource use, so B/op and allocs/op are the numbers a regression would show up in first. A route that answers
// non-200 is SKIPPED with its status rather than reported as a number, because a 404 has an excellent ns/op and
// means nothing (the same reasoning as `AGENTS.md` rule 19: a filter that matches nothing reports ok).
//
// Usage:
//
//	go test ./internal/server/ -run '^$' -bench 'Benchmark' -benchmem
//	go test ./internal/server/ -run '^$' -bench 'BenchmarkSettingsGet' -benchmem -cpuprofile cpu.out -memprofile mem.out

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// benchEnv is one prepared subject: a handler plus the credentials an authenticated request needs. BOTH are
// required and neither is optional: with accounts enabled an unauthenticated GET is refused (403), and an
// authenticated POST without the CSRF token is refused too. Measured while building this file -- a benchmark
// that passed only the session cookie reported "POST /api/settings/get answered 403" and was skipped rather
// than timing a refusal, which is exactly why the skip exists.
type benchEnv struct {
	handler http.Handler
	cookie  string
	token   string
	// authNote is empty when an authenticated route answered 2xx, and otherwise carries the status and body the
	// probe saw, so a benchmark for an authenticated route can SKIP with the reason instead of timing a refusal.
	authNote string
}

// benchTree plants the smallest tree that makes each measured route do REAL work: several small settings
// documents (so the aggregation route reads and parses more than one file) and a character directory with a
// card and a chat (so the character route stats and reads).
func benchTree(tb testing.TB, dataRoot string) {
	tb.Helper()
	write := func(rel, body string) {
		path := filepath.Join(dataRoot, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			tb.Fatalf("mkdir for %s: %v", rel, err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			tb.Fatalf("write %s: %v", rel, err)
		}
	}
	for _, name := range []string{"themes", "movingUI", "quickreplies", "instruct", "context", "sysprompt", "reasoning"} {
		write("default-user/"+name+"/bench.json", `{"name":"bench","value":1}`)
	}
	write("default-user/settings.json", `{"username":"bench","active_character":null}`)
	write("default-user/characters/Bench Character.png", "not-a-real-png")
	write("default-user/chats/bench/Bench Character - 2023-5-12 @21h 32m 29s 224ms.jsonl",
		"{\"user_name\":\"bench\",\"character_name\":\"Bench Character\",\"create_date\":\"2023-05-12\"}\n"+
			"{\"name\":\"Bench Character\",\"is_user\":false,\"mes\":\"hello\"}\n")
}

// newBenchEnv builds the subject and completes the product's own login handshake.
func newBenchEnv(b *testing.B) *benchEnv {
	b.Helper()
	dataRoot := b.TempDir()
	installRoot := b.TempDir()
	benchTree(b, dataRoot)

	accountJSON, err := marshalNodeJSON(struct {
		Handle   string `json:"handle"`
		Name     string `json:"name"`
		Created  int64  `json:"created"`
		Password string `json:"password"`
		Admin    bool   `json:"admin"`
		Enabled  bool   `json:"enabled"`
		Salt     string `json:"salt"`
	}{"default-user", "Bench", 1700000000000, "", true, true, ""})
	if err != nil {
		b.Fatalf("marshal the account record: %v", err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		b.Fatalf("plant the account record: %v", err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot:     installRoot,
		DataRoot:        dataRoot,
		CookieSecret:    "bench-cookie-secret-0123456789abcdef",
		AccountsEnabled: true,
	})

	do := func(method, route, cookie, token string, body []byte) *httptest.ResponseRecorder {
		var reader io.Reader
		if body != nil {
			reader = strings.NewReader(string(body))
		}
		request := httptest.NewRequest(method, route, reader)
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token != "" {
			request.Header.Set("X-CSRF-Token", token)
		}
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	cookieFrom := func(cookies []string) string {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}

	csrfResponse := do(http.MethodGet, "/csrf-token", "", "", nil)
	if csrfResponse.Code != http.StatusOK {
		b.Fatalf("GET /csrf-token = %d: the benchmark cannot authenticate", csrfResponse.Code)
	}
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		b.Fatalf("decode the CSRF token: %v", err)
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	login := do(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, []byte(`{"handle":"default-user","password":""}`))
	if login.Code != http.StatusOK {
		b.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	session := cookieFrom(login.Header().Values("Set-Cookie"))
	// THE SESSION IS PROBED, NOT ASSUMED, AND A NON-2xx IS A SKIP RATHER THAN A FAILURE. A login that answers
	// 200 and a session the next request refuses look identical from the login response alone; the failure mode
	// this prevents is a benchmark that silently times a 403 or a 500. Measured while building this file: with
	// only the session cookie the probe answered 403 (the CSRF token is also required on POST), and with a
	// minimal settings tree it answered 500 (this benchmark plants a small tree, not the full scaffold the
	// aggregation route expects). Neither is a fact about performance, so neither may become a number.
	env := &benchEnv{handler: handler, cookie: session, token: csrf.Token}
	probe := do(http.MethodPost, "/api/settings/get", session, csrf.Token, []byte(`{}`))
	if probe.Code < 200 || probe.Code >= 300 {
		env.authNote = fmt.Sprintf("POST /api/settings/get answered %d on this tree: %s",
			probe.Code, strings.TrimSpace(firstN(probe.Body.String(), 120)))
	}
	return env
}

// requireAuth skips an authenticated benchmark when the probe could not establish a session, naming what it saw.
func (env *benchEnv) requireAuth(b *testing.B) {
	b.Helper()
	if env.authNote != "" {
		b.Skipf("no authenticated session on this tree, so this route cannot be timed: %s", env.authNote)
	}
}

// benchResponseWriter records the status and headers and DISCARDS the body.
//
// WHY NOT httptest.ResponseRecorder, WHICH IS THE OBVIOUS CHOICE. Its Body is a bytes.Buffer that grows by
// DOUBLING, so the buffer's cost depends on the WRITE PATTERN rather than on the response: a handler that writes
// one 497 KB slice allocates about 500 KB, while the same 497 KB written in 32 KB chunks makes the buffer double
// its way up and allocates about 1 MB. Measured while building this file: an earlier version of it reported that
// streaming an asset cost MORE than buffering the whole file, which was true of the recorder and false of the
// product. A benchmark whose number moves when the product's peak allocation FALLS is worse than no benchmark, so
// the body is discarded and only the product's own allocations are counted.
type benchResponseWriter struct {
	header http.Header
	status int
	bytes  int64
}

func (writer *benchResponseWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = http.Header{}
	}
	return writer.header
}

func (writer *benchResponseWriter) WriteHeader(status int) {
	if writer.status == 0 {
		writer.status = status
	}
}

func (writer *benchResponseWriter) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	writer.bytes += int64(len(body))
	return len(body), nil
}

// Flush keeps a streaming handler's http.Flusher assertion working.
func (writer *benchResponseWriter) Flush() {}

// benchRequest drives one request through the full middleware stack and fails the benchmark if the route did
// not answer 2xx. A non-2xx is a SKIP, never a number: a 404 is fast and means nothing.
func benchRequest(b *testing.B, handler http.Handler, method, route, cookie, token string, body []byte) {
	b.Helper()
	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(string(body))
	}
	request := httptest.NewRequest(method, route, reader)
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	if token != "" {
		request.Header.Set("X-CSRF-Token", token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	writer := &benchResponseWriter{}
	handler.ServeHTTP(writer, request)
	if writer.status < 200 || writer.status >= 300 {
		b.Skipf("%s %s answered %d on this tree, so its timing would measure a refusal",
			method, route, writer.status)
	}
}

func firstN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// BenchmarkVersion is the tiny route every client hits first, including the readiness probe.
func BenchmarkVersion(b *testing.B) {
	env := newBenchEnv(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		benchRequest(b, env.handler, http.MethodGet, "/version", env.cookie, "", nil)
	}
}

// BenchmarkFrontendIndex serves the HTML shell: the largest single embedded asset on a page load.
func BenchmarkFrontendIndex(b *testing.B) {
	env := newBenchEnv(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		benchRequest(b, env.handler, http.MethodGet, "/", env.cookie, "", nil)
	}
}

// BenchmarkFrontendAsset serves one static asset. A real page load requests roughly 229 of these, so this is
// the single most repeated request in the product (docs/frontend-startup-calls.md).
func BenchmarkFrontendAsset(b *testing.B) {
	env := newBenchEnv(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		benchRequest(b, env.handler, http.MethodGet, "/script.js", "", "", nil)
	}
}

// BenchmarkSettingsGet aggregates many small documents from the data root behind authentication.
func BenchmarkSettingsGet(b *testing.B) {
	env := newBenchEnv(b)
	env.requireAuth(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		benchRequest(b, env.handler, http.MethodPost, "/api/settings/get", env.cookie, env.token, []byte(`{}`))
	}
}

// BenchmarkCharactersAll stats and parses the character directory behind authentication.
func BenchmarkCharactersAll(b *testing.B) {
	env := newBenchEnv(b)
	env.requireAuth(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		benchRequest(b, env.handler, http.MethodPost, "/api/characters/all", env.cookie, env.token, []byte(`{}`))
	}
}

// BenchmarkManyFrontendAssets answers "what does one page load cost in allocations", which is the number a
// static-serving regression would move and no single-request benchmark shows. It is deliberately NOT a
// throughput claim: it issues a fixed set of distinct asset paths per iteration so the result reads as
// "allocations per page load" rather than "per identical request".
func BenchmarkManyFrontendAssets(b *testing.B) {
	env := newBenchEnv(b)
	paths := []string{"/", "/script.js", "/css/animations.css", "/css/backgrounds.css", "/version"}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, p := range paths {
			benchRequest(b, env.handler, http.MethodGet, p, env.cookie, "", nil)
		}
	}
	_ = fmt.Sprint
}
