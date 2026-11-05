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
// The M2b scale set below (`...Scale`, `BenchmarkChatSummary`, `BenchmarkChatsRecent`, `BenchmarkStaticPageLoad`,
// `BenchmarkChatCompletionAssemble`, `BenchmarkChatCompletionMarshal`) is over GENERATED fixtures at real data
// scales: 100/1000/10000 character cards, 10/100/1000 JSONL chats with a very long single-line message and
// CRLF/LF mixes, 220/1100 preset/theme/QR documents, 50/200/1000 world files, all 229 recorded page-load paths,
// and the provider-path assemble/marshal that no benchmark in this file covered before. The fixture-generation
// rationale is in the M2b section header further down.
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
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
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
	for _, name := range []string{"themes", "movingUI", "quickreplies", "instruct", "context", "sysprompt", "reasoning",
		"NovelAI Settings", "KoboldAI Settings", "OpenAI Settings", "TextGen Settings", "worlds"} {
		write("default-user/"+name+"/bench.json", `{"name":"bench","value":1}`)
	}
	write("default-user/settings.json", `{"username":"bench","active_character":null}`)
	write("default-user/characters/Bench Character.png", "not-a-real-png")
	write("default-user/chats/bench/Bench Character - 2023-5-12 @21h 32m 29s 224ms.jsonl",
		"{\"user_name\":\"bench\",\"character_name\":\"Bench Character\",\"create_date\":\"2023-05-12\"}\n"+
			"{\"name\":\"Bench Character\",\"is_user\":false,\"mes\":\"hello\"}\n")
}

// newBenchEnv builds the subject over the smallest planted tree and completes the product's own login
// handshake. The scale benchmarks below use newBenchEnvWithTree so they can plant a generated tree instead;
// everything after the tree (account record, handler, CSRF + login, session probe) is SHARED, which is what
// keeps a scale number comparable with the small-tree number next to it.
func newBenchEnv(b *testing.B) *benchEnv {
	b.Helper()
	return newBenchEnvWithTree(b, benchTree)
}

// newBenchEnvWithTree builds the subject over a caller-planted tree, then performs the same account record,
// handler construction, CSRF handshake and login probe as newBenchEnv.
func newBenchEnvWithTree(b *testing.B, plant func(tb testing.TB, dataRoot string)) *benchEnv {
	b.Helper()
	dataRoot := b.TempDir()
	installRoot := b.TempDir()
	if plant == nil {
		benchTree(b, dataRoot)
	} else {
		plant(b, dataRoot)
	}

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

// ===================================================================================================
// M2b: SCALE BENCHMARKS OVER GENERATED FIXTURES
//
// WHY THIS SECTION EXISTS. The six benchmarks above all run over one planted card and one two-line chat, so
// they answer "does the route work" and cannot answer the questions the M0 audit left open: how `/characters/all`
// scales at 100/1000/10000 cards, how a chat summary scales with JSONL bytes, how settings aggregation scales
// with the number of preset/theme/QR files, how World Info listing scales with the number of world files, what
// one real page load costs across its whole 229-request manifest, and what the provider request ASSEMBLY costs
// before any socket exists. Every fixture below is GENERATED from a fixed seed, so the same input bytes are
// produced on every host and a before/after comparison is same-input by construction.
//
// WHAT IS FAITHFUL AND WHAT IS A DELIBERATE PROXY (so no scale number is read as a page-load claim):
//
//   - Character cards are REAL PNGs: correct signature, IHDR, IDAT, a `chara` tEXt chunk carrying a base64
//     v2 card JSON, valid per-chunk CRC, IEND. The reader never decodes IDAT; it copies every chunk's payload
//     and parses the card JSON. A real avatar's 0.5-2 MB lives in image chunks that cost the product
//     read + CRC + copy, so the avatar payload is represented by ONE valid ancillary chunk (`prVt`) filled
//     with deterministic pseudo-random bytes of the same size: same bytes on disk, same read, same CRC walk,
//     same copy, same page-cache pressure, and the product's output is identical because that chunk is never
//     interpreted. Per-card cost is therefore linear in FILE BYTES, which is why the subtests state the
//     per-card byte budget and why a 100-card 640 KB row is included next to the 100/1000/10000 rows: it
//     measures the image-byte coefficient, while the three required scales keep the total fixture near 70 MB.
//   - Chat JSONL is REAL JSONL: a chat_metadata first line, then message objects, LF and CRLF files mixed,
//     plus one file whose FIRST message is a single very long line. This is the exact shape that makes
//     `getChatInfo` read the whole file to return a count and a preview.
//   - Settings, presets, themes and quick replies are real .json documents under the real directory names:
//     `/api/settings/get` reads and re-serializes every one of them, so the cost is file count x file bytes.
//   - World files are real world-info documents (`entries` object with one padded entry).
//   - The page-load manifest is PARSED FROM `docs/frontend-startup-calls.md`, the same enumeration the
//     repository already uses, and its row count is asserted to be 229. No second hand-kept path list exists
//     that could drift from the document.
//   - Provider assembly uses the LARGEST request body in `tests/oracle/sillytavern-1.19.0-provider-wire.json`,
//     decoded and planned with the product's own `pinnedChatCompletionPlan`; the marshal benchmark marshals
//     the PRODUCED provider body, which is the bytes that go on the wire.
//
// NO PRIVATE DATA. Every byte is generated here from fixed constants; the pseudo-random stream is the
// xorshift64* below with a per-fixture seed. Nothing is read from a user tree.

// benchDefaultHandle is the handle every generated tree is planted under.
const benchDefaultHandle = "default-user"

// benchWriteFile writes one generated fixture file, creating parents. Generated bodies are byte slices that
// were built in memory, so a test failure names the path instead of a silent empty file.
func benchWriteFile(tb testing.TB, dataRoot, relative string, body []byte) {
	tb.Helper()
	path := filepath.Join(dataRoot, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		tb.Fatalf("create parent of %s: %v", relative, err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		tb.Fatalf("write fixture %s: %v", relative, err)
	}
}

// benchNoise returns n deterministic pseudo-random bytes. xorshift64* is used instead of math/rand so the
// stream is fixed by the implementation in this file and cannot change with a stdlib version.
func benchNoise(seed uint64, n int) []byte {
	out := make([]byte, n)
	state := seed
	for index := range out {
		state ^= state >> 12
		state ^= state << 25
		state ^= state >> 27
		out[index] = byte((state * 2685821657736338717) >> 33)
	}
	return out
}

// benchPNGChunk builds one PNG chunk with its CRC, which is what `extractPngChunks` validates.
func benchPNGChunk(name string, data []byte) []byte {
	out := make([]byte, 0, len(data)+12)
	var word [4]byte
	binary.BigEndian.PutUint32(word[:], uint32(len(data)))
	out = append(out, word[:]...)
	out = append(out, name...)
	out = append(out, data...)
	crc := crc32.NewIEEE()
	_, _ = crc.Write([]byte(name))
	_, _ = crc.Write(data)
	binary.BigEndian.PutUint32(word[:], crc.Sum32())
	return append(out, word[:]...)
}

// benchPixelIDAT is a zlib stream for one 1x1 truecolour pixel, so the generated card is a decodable PNG.
func benchPixelIDAT() []byte {
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	_, _ = writer.Write([]byte{0x00, 0x10, 0x20, 0x30}) // filter byte + RGB
	_ = writer.Close()
	return compressed.Bytes()
}

// benchCardJSON builds a valid character-card v2 JSON document of approximately target bytes, padding the
// prose fields with 'A'. Field names are the ones `getCharaCardV2`/`readFromV2` require, so the card takes the
// same projection path a real card does; only the prose length is synthetic.
func benchCardJSON(target int) []byte {
	const document = `{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"Bench Card","description":"%s","personality":"%s","scenario":"%s","first_mes":"%s","mes_example":"%s","creator_notes":"%s","system_prompt":"","post_history_instructions":"","alternate_greetings":[],"tags":["bench"],"creator":"bench","character_version":"1.0","extensions":{"talkativeness":"0.5","fav":false,"world":""}}}`
	base := fmt.Sprintf(document, "", "", "", "", "", "")
	remaining := target - len(base)
	if remaining < 0 {
		remaining = 0
	}
	pad := func(size int) string {
		if size <= 0 {
			return ""
		}
		return strings.Repeat("A", size)
	}
	share := remaining / 6
	return []byte(fmt.Sprintf(document,
		pad(share), pad(share), pad(share), pad(share), pad(share), pad(remaining-share*5)))
}

var benchPNGSignature = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}

// benchCardPNG builds the real-PNG card described in this section's header. imageBytes is the avatar payload
// proxy; cardBytes is the JSON document size.
func benchCardPNG(imageBytes, cardBytes int) []byte {
	var out bytes.Buffer
	out.Write(benchPNGSignature)
	out.Write(benchPNGChunk("IHDR", []byte{
		0x00, 0x00, 0x00, 0x01, // width 1
		0x00, 0x00, 0x00, 0x01, // height 1
		0x08, 0x02, 0x00, 0x00, 0x00, // bit depth 8, truecolour, deflate, no filter, no interlace
	}))
	if imageBytes > 0 {
		out.Write(benchPNGChunk("prVt", benchNoise(uint64(imageBytes)+7, imageBytes)))
	}
	out.Write(benchPNGChunk("IDAT", benchPixelIDAT()))
	out.Write(benchPNGChunk("tEXt", []byte("chara\x00"+base64.StdEncoding.EncodeToString(benchCardJSON(cardBytes)))))
	out.Write(benchPNGChunk("IEND", nil))
	return out.Bytes()
}

// plantBenchSettingsBase creates every directory `/api/settings/get` reads, because that route answers 500
// when one is absent (the route's own behaviour, not a fixture choice). filesPerDir=0 creates empty
// directories, which is the smallest tree the route accepts.
func plantBenchSettingsBase(tb testing.TB, dataRoot string, filesPerDir, fileBytes int) {
	tb.Helper()
	benchWriteFile(tb, dataRoot, benchDefaultHandle+"/settings.json",
		[]byte(`{"username":"bench","active_character":null}`))
	benchWriteFile(tb, dataRoot, benchDefaultHandle+"/worlds/Bench World.json", benchWorldJSON(0, 512))
	for _, directory := range []string{
		"NovelAI Settings", "KoboldAI Settings", "OpenAI Settings", "TextGen Settings",
		"themes", "movingUI", "QuickReplies", "instruct", "context", "sysprompt", "reasoning",
	} {
		if filesPerDir == 0 {
			if err := os.MkdirAll(filepath.Join(dataRoot, benchDefaultHandle, directory), 0o755); err != nil {
				tb.Fatalf("create %s: %v", directory, err)
			}
			continue
		}
		for index := 0; index < filesPerDir; index++ {
			name := fmt.Sprintf("%s/%s/bench-%03d.json", benchDefaultHandle, directory, index)
			benchWriteFile(tb, dataRoot, name, benchSettingsDocument(directory, index, fileBytes))
		}
	}
}

// benchSettingsDocument is a valid JSON document of approximately target bytes. The aggregation route only
// requires valid JSON and re-serializes it; the "name" keeps files distinguishable in a decoded body.
func benchSettingsDocument(directory string, index, target int) []byte {
	base := fmt.Sprintf(`{"name":"%s %03d","temperature":1,"payload":""}`, directory, index)
	remaining := target - len(base)
	if remaining < 0 {
		remaining = 0
	}
	return []byte(fmt.Sprintf(`{"name":"%s %03d","temperature":1,"payload":"%s"}`,
		directory, index, strings.Repeat("p", remaining)))
}

// benchWorldJSON builds a world-info document of approximately target bytes with one padded entry.
func benchWorldJSON(index, target int) []byte {
	base := fmt.Sprintf(`{"entries":{"0":{"uid":0,"key":["trigger-%03d"],"keysecondary":[],"comment":"","content":"","constant":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":100,"position":0,"disable":false,"excludeRecursion":false,"preventRecursion":false,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":null,"matchWholeWords":null,"useGroupScoring":null,"automationId":"","role":0,"vectorized":false,"sticky":0,"cooldown":0,"delay":0,"extensions":{}}}}`, index)
	remaining := target - len(base)
	if remaining < 0 {
		remaining = 0
	}
	return []byte(fmt.Sprintf(`{"entries":{"0":{"uid":0,"key":["trigger-%03d"],"keysecondary":[],"comment":"","content":"%s","constant":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":100,"position":0,"disable":false,"excludeRecursion":false,"preventRecursion":false,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":null,"matchWholeWords":null,"useGroupScoring":null,"automationId":"","role":0,"vectorized":false,"sticky":0,"cooldown":0,"delay":0,"extensions":{}}}}`,
		index, strings.Repeat("w", remaining)))
}

// plantCharacterTree plants `cards` generated PNG cards plus the settings base the auth probe needs.
func plantCharacterTree(tb testing.TB, dataRoot string, cards, imageBytes, cardBytes int) {
	tb.Helper()
	plantBenchSettingsBase(tb, dataRoot, 1, 64)
	card := benchCardPNG(imageBytes, cardBytes)
	for index := 0; index < cards; index++ {
		relative := fmt.Sprintf("%s/characters/Bench Card %05d.png", benchDefaultHandle, index)
		benchWriteFile(tb, dataRoot, relative, card)
	}
}

// plantChatTree plants one character with `chats` JSONL files of approximately totalBytes each. Half the
// files use LF and half use CRLF (the two real line-ending families the Node readline port must count
// identically), and the first file's first message is a single very long line.
func plantChatTree(tb testing.TB, dataRoot string, chats, totalBytes int) {
	tb.Helper()
	plantBenchSettingsBase(tb, dataRoot, 1, 64)
	benchWriteFile(tb, dataRoot, benchDefaultHandle+"/characters/Bench Character.png", benchCardPNG(1024, 1024))
	for index := 0; index < chats; index++ {
		ending := "\n"
		if index%2 == 1 {
			ending = "\r\n"
		}
		target := totalBytes
		var body strings.Builder
		body.WriteString(`{"user_name":"bench","character_name":"Bench Character","create_date":"2024-01-01"}` + ending)
		messageIndex := 0
		for body.Len() < target-1024 {
			payload := strings.Repeat("m", 250)
			if index == 0 && messageIndex == 0 {
				payload = strings.Repeat("L", max(target/2, 4096))
			}
			line := fmt.Sprintf(`{"name":"Bench","is_user":false,"mes":"%s","send_date":"2024-01-01T00:00:00.000Z"}`, payload)
			if body.Len()+len(line)+len(ending) > target {
				break
			}
			body.WriteString(line + ending)
			messageIndex++
		}
		relative := fmt.Sprintf("%s/chats/Bench Character/Bench Chat %04d.jsonl", benchDefaultHandle, index)
		benchWriteFile(tb, dataRoot, relative, []byte(body.String()))
	}
}

// benchStaticManifest parses the 229-path page-load enumeration out of docs/frontend-startup-calls.md. The
// document IS the manifest: the count is asserted here, so a document edit that changes it fails this
// benchmark loudly instead of silently changing what "one page load" means.
func benchStaticManifest(tb testing.TB) []struct{ method, path string } {
	tb.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "docs", "frontend-startup-calls.md"))
	if err != nil {
		tb.Fatalf("read the page-load enumeration: %v", err)
	}
	var manifest []struct{ method, path string }
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "| ") {
			continue
		}
		fields := strings.Split(line, "|")
		if len(fields) < 3 {
			continue
		}
		method := strings.TrimSpace(fields[1])
		switch method {
		case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead, http.MethodOptions:
		default:
			continue
		}
		path := strings.Trim(strings.TrimSpace(fields[2]), "`")
		if path == "" {
			continue
		}
		manifest = append(manifest, struct{ method, path string }{method, path})
	}
	if len(manifest) != 229 {
		tb.Fatalf("docs/frontend-startup-calls.md enumerates %d paths, the recorded page load is 229", len(manifest))
	}
	return manifest
}

// benchServe is the non-skipping request driver used where a status is EXPECTED to vary (the page-load
// manifest contains the document's own non-2xx cosmetic rows). Authenticated route benchmarks keep using
// benchRequest, whose non-2xx is a SKIP.
func benchServe(handler http.Handler, method, route, cookie, token string, body []byte) *benchResponseWriter {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
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
	return writer
}

// BenchmarkCharactersAllScale is the M0 "card read/parse" hypothesis made measurable. Subtests state the
// PER-CARD byte budget; see this section's header for why the avatar payload is an uninterpreted chunk and
// why the 100-card 640 KB row exists next to the required 100/1000/10000 rows.
func BenchmarkCharactersAllScale(b *testing.B) {
	cases := []struct {
		name             string
		cards, imageSize int
		cardBytes        int
	}{
		{"cards_100_128KB_image", 100, 128 << 10, 8 << 10},
		{"cards_1000_32KB_image", 1000, 32 << 10, 8 << 10},
		{"cards_10000_4KB_image", 10000, 4 << 10, 2 << 10},
		{"cards_100_640KB_image", 100, 640 << 10, 12 << 10},
	}
	for _, testCase := range cases {
		testCase := testCase
		b.Run(testCase.name, func(b *testing.B) {
			env := newBenchEnvWithTree(b, func(tb testing.TB, dataRoot string) {
				plantCharacterTree(tb, dataRoot, testCase.cards, testCase.imageSize, testCase.cardBytes)
			})
			env.requireAuth(b)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				benchRequest(b, env.handler, http.MethodPost, "/api/characters/all", env.cookie, env.token, []byte(`{}`))
			}
		})
	}
}

// BenchmarkCharactersAllScaleColdFirstRequest is the card-text cache's COLD guard. It empties the cache before
// EVERY request, so each iteration repeats the work the pre-cache code did (stat + ReadFile + PNG chunk walk +
// base64 decode) WITH the cache lookup present. Its numbers must stay inside the noise band of the pre-cache
// BenchmarkCharactersAllScale rows: a material rise means the lookup costs more than the read it saves.
//
// The warm rows (BenchmarkCharactersAllScale, which the cache makes repeat-serve) and these cold rows are the
// before/after pair for GOAL §15.2: both measure the same routes over the same generated trees.
func BenchmarkCharactersAllScaleColdFirstRequest(b *testing.B) {
	cases := []struct {
		name             string
		cards, imageSize int
		cardBytes        int
	}{
		{"cards_100_128KB_image", 100, 128 << 10, 8 << 10},
		{"cards_1000_32KB_image", 1000, 32 << 10, 8 << 10},
		{"cards_10000_4KB_image", 10000, 4 << 10, 2 << 10},
		{"cards_100_640KB_image", 100, 640 << 10, 12 << 10},
	}
	for _, testCase := range cases {
		testCase := testCase
		b.Run(testCase.name, func(b *testing.B) {
			env := newBenchEnvWithTree(b, func(tb testing.TB, dataRoot string) {
				plantCharacterTree(tb, dataRoot, testCase.cards, testCase.imageSize, testCase.cardBytes)
			})
			env.requireAuth(b)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				// The reset is outside the timed region so the benchmark measures the request, not the harness.
				b.StopTimer()
				resetCharacterCardCache()
				b.StartTimer()
				benchRequest(b, env.handler, http.MethodPost, "/api/characters/all", env.cookie, env.token, []byte(`{}`))
			}
		})
	}
}

// BenchmarkChatSummary is the M0 "chat summary whole-file read" hypothesis made measurable: N chats x M bytes
// behind one character, answered by /api/characters/chats (getChatInfo per file).
func BenchmarkChatSummary(b *testing.B) {
	cases := []struct {
		name         string
		chats, bytes int
	}{
		{"chats_10_x_2MB", 10, 2 << 20},
		{"chats_100_x_256KB", 100, 256 << 10},
		{"chats_1000_x_16KB", 1000, 16 << 10},
	}
	for _, testCase := range cases {
		testCase := testCase
		b.Run(testCase.name, func(b *testing.B) {
			env := newBenchEnvWithTree(b, func(tb testing.TB, dataRoot string) {
				plantChatTree(tb, dataRoot, testCase.chats, testCase.bytes)
			})
			env.requireAuth(b)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				benchRequest(b, env.handler, http.MethodPost, "/api/characters/chats", env.cookie, env.token,
					[]byte(`{"avatar_url":"Bench Character.png","metadata":true}`))
			}
		})
	}
}

// BenchmarkChatsRecent measures the other chat-summary surface: it enumerates the characters directory, stats
// every chat file, sorts by mtime, then summarizes the top `max` entries. Same fixture as BenchmarkChatSummary.
func BenchmarkChatsRecent(b *testing.B) {
	cases := []struct {
		name         string
		chats, bytes int
	}{
		{"chats_10_x_2MB", 10, 2 << 20},
		{"chats_100_x_256KB", 100, 256 << 10},
		{"chats_1000_x_16KB", 1000, 16 << 10},
	}
	for _, testCase := range cases {
		testCase := testCase
		b.Run(testCase.name, func(b *testing.B) {
			env := newBenchEnvWithTree(b, func(tb testing.TB, dataRoot string) {
				plantChatTree(tb, dataRoot, testCase.chats, testCase.bytes)
			})
			env.requireAuth(b)
			body := []byte(fmt.Sprintf(`{"max":%d,"metadata":true,"pinned":[]}`, testCase.chats))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				benchRequest(b, env.handler, http.MethodPost, "/api/chats/recent", env.cookie, env.token, body)
			}
		})
	}
}

// BenchmarkSettingsGetScale is the M0 "settings aggregation re-reads every file" hypothesis made measurable:
// 11 directories x filesPerDir generated documents, all read and re-serialized per request.
func BenchmarkSettingsGetScale(b *testing.B) {
	for _, perDir := range []int{20, 100} {
		perDir := perDir
		b.Run(fmt.Sprintf("files_per_dir_%d", perDir), func(b *testing.B) {
			env := newBenchEnvWithTree(b, func(tb testing.TB, dataRoot string) {
				plantBenchSettingsBase(tb, dataRoot, perDir, 2<<10)
			})
			env.requireAuth(b)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				benchRequest(b, env.handler, http.MethodPost, "/api/settings/get", env.cookie, env.token, []byte(`{}`))
			}
		})
	}
}

// BenchmarkWorldInfoList measures /api/worldinfo/list, which reads and parses every world file to emit
// file_id/name/extensions.
func BenchmarkWorldInfoList(b *testing.B) {
	cases := []struct {
		name          string
		worlds, bytes int
	}{
		{"worlds_50_x_128KB", 50, 128 << 10},
		{"worlds_200_x_32KB", 200, 32 << 10},
		{"worlds_1000_x_8KB", 1000, 8 << 10},
	}
	for _, testCase := range cases {
		testCase := testCase
		b.Run(testCase.name, func(b *testing.B) {
			env := newBenchEnvWithTree(b, func(tb testing.TB, dataRoot string) {
				plantBenchSettingsBase(tb, dataRoot, 1, 64)
				for index := 0; index < testCase.worlds; index++ {
					relative := fmt.Sprintf("%s/worlds/Bench World %04d.json", benchDefaultHandle, index)
					benchWriteFile(tb, dataRoot, relative, benchWorldJSON(index, testCase.bytes))
				}
			})
			env.requireAuth(b)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				benchRequest(b, env.handler, http.MethodPost, "/api/worldinfo/list", env.cookie, env.token, []byte(`{}`))
			}
		})
	}
}

// benchServeManifestPath drives one page-load manifest row. The manifest records the browser's POSTs too, so
// a mutating method gets an empty JSON body rather than a nil one: a nil body changes which middleware branch
// answers, and the resulting status would describe a request the browser never made.
func benchServeManifestPath(handler http.Handler, entry struct{ method, path string }, cookie, token string) *benchResponseWriter {
	var body []byte
	if entry.method == http.MethodPost || entry.method == http.MethodPut {
		body = []byte(`{}`)
	}
	return benchServe(handler, entry.method, entry.path, cookie, token, body)
}

// BenchmarkStaticPageLoad times the WHOLE recorded page-load manifest, not one asset: one op is one page load.
// The manifest's documented non-2xx cosmetic rows are allowed through, but a 2xx collapse (a route or asset
// that stopped being served) fails the benchmark, because then the number would describe a different page.
func BenchmarkStaticPageLoad(b *testing.B) {
	env := newBenchEnv(b)
	manifest := benchStaticManifest(b)
	twoXX, bytesServed := 0, int64(0)
	nonTwoXX := make([]string, 0, 8)
	for _, entry := range manifest {
		writer := benchServeManifestPath(env.handler, entry, env.cookie, env.token)
		if writer.status >= 200 && writer.status < 300 {
			twoXX++
			bytesServed += writer.bytes
			continue
		}
		nonTwoXX = append(nonTwoXX, fmt.Sprintf("%s %s -> %d", entry.method, entry.path, writer.status))
	}
	b.Logf("page-load manifest: %d paths, %d answered 2xx, non-2xx: %v", len(manifest), twoXX, nonTwoXX)
	// The document itself records three non-2xx cosmetic rows (an absent transparent background, the Horde
	// text-workers route that refuses for want of a key, and no-response rows); more than that means page-load
	// composition changed and this benchmark no longer measures the recorded page.
	if twoXX < 225 {
		b.Fatalf("only %d of %d page-load paths answered 2xx; refusing to time a different page: %v",
			twoXX, len(manifest), nonTwoXX)
	}
	b.SetBytes(bytesServed)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, entry := range manifest {
			benchServeManifestPath(env.handler, entry, env.cookie, env.token)
		}
	}
}

// benchWireCapture is the minimal view of the provider-wire oracle needed to pick the largest recorded
// browser-equivalent request body. The full typed capture belongs to the oracle test; reusing its shape here
// would make this benchmark depend on the assertion struct, which is not the point.
type benchWireCapture struct {
	Scenarios map[string]struct {
		HTTP struct {
			Requests []struct {
				Body json.RawMessage `json:"body"`
			} `json:"requests"`
		} `json:"http"`
	} `json:"scenarios"`
}

// benchLargestProviderBody returns the scenario whose ASSEMBLED provider request is the largest one the
// recorded provider-wire corpus can produce from an empty directory set, together with the browser body that
// produced it and the provider bytes. Largest ASSEMBLED body is the right subject for an assemble/marshal
// benchmark: the marshal hypothesis is about the bytes that go on the wire, so a scenario with a large
// browser body but a small provider body would measure the wrong half. The choice is deterministic: plan every
// scenario, keep the largest provider body, break ties by browser body and then by name.
func benchLargestProviderBody(tb testing.TB) (name string, raw []byte, planBody []byte) {
	tb.Helper()
	bytesOfCapture, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		tb.Fatalf("read the provider-wire oracle: %v", err)
	}
	var capture benchWireCapture
	if err := json.Unmarshal(bytesOfCapture, &capture); err != nil {
		tb.Fatalf("decode the provider-wire oracle: %v", err)
	}
	names := make([]string, 0, len(capture.Scenarios))
	for scenarioName := range capture.Scenarios {
		names = append(names, scenarioName)
	}
	sort.Strings(names)
	bestName, bestRaw, bestPlan := "", []byte(nil), []byte(nil)
	for _, scenarioName := range names {
		scenario := capture.Scenarios[scenarioName]
		if len(scenario.HTTP.Requests) == 0 || len(scenario.HTTP.Requests[0].Body) == 0 {
			continue
		}
		body, decodeErr := decodeOrderedNodeJSON(scenario.HTTP.Requests[0].Body)
		if decodeErr != nil {
			continue
		}
		plan, failure := pinnedChatCompletionPlan(body, startup.UserDirectories{}, "")
		if failure != nil || plan == nil || len(plan.Body) == 0 {
			continue
		}
		if len(plan.Body) > len(bestPlan) || (len(plan.Body) == len(bestPlan) && len(scenario.HTTP.Requests[0].Body) > len(bestRaw)) {
			bestName, bestRaw, bestPlan = scenarioName, scenario.HTTP.Requests[0].Body, plan.Body
		}
	}
	if len(bestPlan) == 0 {
		tb.Fatalf("no provider-wire scenario produced a plan with an empty directory set")
	}
	tb.Logf("provider assembly fixture: scenario %q, browser body %d B, provider body %d B",
		bestName, len(bestRaw), len(bestPlan))
	return bestName, bestRaw, bestPlan
}

// benchScaledProviderBody expands a recorded browser body's messages array to a deterministic large body, so
// the assemble/marshal benchmarks also have a SIZED datapoint beyond the ~1 KB recorded scenarios. The shape
// is the recorded one (same source, same keys, same message roles); only the number and length of messages
// change, which is exactly the axis a real long conversation grows along. Returns nil when the recorded body
// is a text-completion body (messages is a string), because there is no faithful expansion of that shape.
func benchScaledProviderBody(tb testing.TB, raw []byte, targetBytes int) []byte {
	tb.Helper()
	decoded, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		tb.Fatalf("decode the recorded browser body: %v", err)
	}
	messages := nodeGet(decoded, "messages")
	if messages.kind != 'a' || len(messages.array) == 0 {
		return nil
	}
	const messageCount = 200
	perMessage := targetBytes / messageCount
	if perMessage < 256 {
		perMessage = 256
	}
	content := strings.Repeat("s", perMessage)
	scaled := make([]orderedNodeJSON, 0, messageCount)
	for index := 0; index < messageCount; index++ {
		template := messages.array[index%len(messages.array)]
		role, ok := nodeGetStringOK(template, "role")
		if !ok || role == "" {
			role = "user"
		}
		message := nodeObject()
		message.setMember("role", nodeString(role))
		message.setMember("content", nodeString(fmt.Sprintf("message %03d %s", index, content)))
		scaled = append(scaled, message)
	}
	nodeSet(&decoded, []string{"messages"}, orderedNodeJSON{kind: 'a', array: scaled})
	encoded, err := marshalOrderedNodeJSON(decoded)
	if err != nil {
		tb.Fatalf("encode the scaled browser body: %v", err)
	}
	return encoded
}

// nodeGetStringOK is the (string, present) form of a member read for a generated fixture; a missing or
// non-string member is a fixture defect only when the caller treats it as required.
func nodeGetStringOK(value orderedNodeJSON, member string) (string, bool) {
	child, exists := value.member(member)
	if !exists || child.kind != 's' {
		return "", false
	}
	text, ok := child.scalar.(string)
	return text, ok
}

// BenchmarkChatCompletionAssemble is the provider-path benchmark the tree did not have: the whole in-process
// assembly of one browser-equivalent request -- decode the request body, resolve the source, run the pinned
// planner, marshal the provider body -- with no socket involved. Same raw input bytes every iteration.
// "largest_recorded" is the oracle's largest assembled provider body; "scaled_1MB" is the same scenario's
// request shape expanded to roughly 1 MB of messages, which is the size a long conversation assembles.
func BenchmarkChatCompletionAssemble(b *testing.B) {
	scenarioName, raw, _ := benchLargestProviderBody(b)
	inputs := []struct {
		name string
		body []byte
	}{
		{"largest_recorded", raw},
	}
	if scaled := benchScaledProviderBody(b, raw, 1<<20); scaled != nil {
		inputs = append(inputs, struct {
			name string
			body []byte
		}{"scaled_1MB", scaled})
	}
	for _, input := range inputs {
		input := input
		b.Run(input.name, func(b *testing.B) {
			b.SetBytes(int64(len(input.body)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				body, err := decodeOrderedNodeJSON(input.body)
				if err != nil {
					b.Fatalf("decode the browser body: %v", err)
				}
				plan, failure := pinnedChatCompletionPlan(body, startup.UserDirectories{}, "")
				if failure != nil || plan == nil || len(plan.Body) == 0 {
					b.Fatalf("scenario %q no longer plans: %+v", scenarioName, failure)
				}
			}
		})
	}
}

// BenchmarkChatCompletionMarshal isolates the marshal half on the PRODUCED provider body: the bytes that
// would go on the wire, decoded into the product's ordered representation and marshalled again. This is the
// allocation shape of `marshalOrderedNodeJSON` -> `entries()` copy+sort per object. "scaled_1MB" measures the
// same marshal on the ~1 MB provider body produced from the expanded conversation.
func BenchmarkChatCompletionMarshal(b *testing.B) {
	_, raw, produced := benchLargestProviderBody(b)
	inputs := []struct {
		name     string
		produced []byte
	}{
		{"largest_recorded", produced},
	}
	if scaledBrowser := benchScaledProviderBody(b, raw, 1<<20); scaledBrowser != nil {
		scaledBody, err := decodeOrderedNodeJSON(scaledBrowser)
		if err != nil {
			b.Fatalf("decode the scaled browser body: %v", err)
		}
		plan, failure := pinnedChatCompletionPlan(scaledBody, startup.UserDirectories{}, "")
		if failure != nil || plan == nil || len(plan.Body) == 0 {
			b.Fatalf("the scaled browser body does not plan: %+v", failure)
		}
		inputs = append(inputs, struct {
			name     string
			produced []byte
		}{"scaled_1MB", plan.Body})
	}
	for _, input := range inputs {
		input := input
		b.Run(input.name, func(b *testing.B) {
			decoded, err := decodeOrderedNodeJSON(input.produced)
			if err != nil {
				b.Fatalf("decode the produced provider body: %v", err)
			}
			b.SetBytes(int64(len(input.produced)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				encoded, err := marshalOrderedNodeJSON(decoded)
				if err != nil {
					b.Fatalf("marshal the provider body: %v", err)
				}
				if len(encoded) == 0 {
					b.Fatal("the provider body marshalled to zero bytes")
				}
			}
		})
	}
}
