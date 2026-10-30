package server

// A LEAK GATE, not a performance gate.
//
// The transport, the account-record cache and the streaming paths all take work off the request goroutine,
// and a leak in any of them shows up as a growing goroutine count or heap after a few hundred requests --
// not as a failing assertion anywhere else in this suite. The measured symptom this file exists for is the
// one the project has already hit once (a process that accumulated state per request and only released it at
// shutdown), and no other test drives enough requests to see it.
//
// WHAT IT ASSERTS, and why each assertion is shaped to avoid flaking:
//   - EXACTLY the expected number of responses arrived, all 200. Without this the test could pass while
//     every request failed, which is the "green that cannot fail" shape rule 7 forbids.
//   - the goroutine count returns to the pre-load baseline within a SETTLE WINDOW (+8 slack for the
//     keep-alive reader goroutines a client pool legitimately holds), and on failure it prints the stacks
//     that did not go away.
//   - the heap after two forced GCs has not grown by more than a generous bound. The bound is deliberately
//     loose: this is a LEAK detector, so it should only fire on per-request accumulation (hundreds of
//     kilobytes per request), never on allocator behaviour.
//
// It runs with the real HTTP handler and a real data root, because the leak would live in the wiring rather
// than in a unit: the account-record cache, the settings aggregation and the static serving all sit behind it.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const soakRequestCount = 200

func TestServerDoesNotAccumulateGoroutinesOrHeapAcrossRepeatedRequests(t *testing.T) {
	if testing.Short() {
		t.Skip("the leak gate drives 200 real requests; -short skips it on purpose rather than pretending")
	}

	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	if err := os.MkdirAll(dataRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	accountJSON := []byte(`{"handle":"default-user","name":"Soak","created":1700000000000,"password":"","admin":true,"enabled":true,"salt":""}`)
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatalf("seed the account: %v", err)
	}
	const cookieSecret = "gotavern-soak-cookie-secret"
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(root, dataRoot, []string{"default-user"}); err != nil {
		t.Fatalf("prepare the user tree: %v", err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: root, DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	client := &http.Client{Timeout: 30 * time.Second}
	t.Cleanup(client.CloseIdleConnections)

	// ---- authenticate (the same two steps the frontend performs) --------------------------------
	csrfResponse, err := client.Get(server.URL + "/csrf-token")
	if err != nil {
		t.Fatalf("GET /csrf-token: %v", err)
	}
	csrfBody, _ := io.ReadAll(csrfResponse.Body)
	csrfResponse.Body.Close()
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfBody, &csrf); err != nil {
		t.Fatalf("decode csrf token: %v", err)
	}
	csrfCookie := cookiePair(csrfResponse.Cookies())

	loginRequest, _ := http.NewRequest(http.MethodPost, server.URL+"/api/users/login", strings.NewReader(`{"handle":"default-user","password":""}`))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("X-CSRF-Token", csrf.Token)
	loginRequest.Header.Set("Cookie", csrfCookie)
	loginResponse, err := client.Do(loginRequest)
	if err != nil {
		t.Fatalf("POST /api/users/login: %v", err)
	}
	loginBody, _ := io.ReadAll(loginResponse.Body)
	loginResponse.Body.Close()
	if loginResponse.StatusCode != http.StatusOK {
		t.Fatalf("login = %d: %s", loginResponse.StatusCode, loginBody)
	}
	cookieHeader := cookiePair(loginResponse.Cookies())

	// ONE request function, four shapes: two authenticated JSON paths, one unauthenticated status path and
	// one static asset. The mix matters -- a leak in the JSON pipeline and a leak in asset serving are
	// different defects, and a single-endpoint soak would only ever find one of them.
	drive := func() {
		post := func(path, body string) {
			request, err := http.NewRequest(http.MethodPost, server.URL+path, bytes.NewReader([]byte(body)))
			if err != nil {
				t.Fatalf("build %s: %v", path, err)
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-CSRF-Token", csrf.Token)
			request.Header.Set("Cookie", cookieHeader)
			response, err := client.Do(request)
			if err != nil {
				t.Fatalf("POST %s: %v", path, err)
			}
			payload, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("POST %s = %d: %s", path, response.StatusCode, payload)
			}
		}
		get := func(path string) {
			request, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
			if err != nil {
				t.Fatalf("build %s: %v", path, err)
			}
			request.Header.Set("Cookie", cookieHeader)
			response, err := client.Do(request)
			if err != nil {
				t.Fatalf("GET %s: %v", path, err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("GET %s = %d", path, response.StatusCode)
			}
		}
		post("/api/characters/all", `{}`)
		post("/api/characters/all", `{}`)
		get("/version")
		get("/script.js")
	}

	// ---- warm up, then take the baseline --------------------------------------------------------
	// The warmup matters: the first requests allocate the parsed settings, the embedded asset map and the
	// account record, and those allocations are not a leak. Measuring the baseline before them would make
	// this test fail for a healthy server.
	for warm := 0; warm < 8; warm++ {
		drive()
	}
	settleGoroutines(t, 5*time.Second)
	runtime.GC()
	runtime.GC()
	var baseline runtime.MemStats
	runtime.ReadMemStats(&baseline)
	baselineGoroutines := runtime.NumGoroutine()
	baselineFiles := openFileCount()
	t.Logf("baseline: %d goroutines, heap %d KiB in use, %d open files", baselineGoroutines, baseline.HeapAlloc/1024, baselineFiles)

	// ---- the load ------------------------------------------------------------------------------
	passed := 0
	for index := 0; index < soakRequestCount/4; index++ {
		drive()
		passed += 4
	}
	if passed != soakRequestCount {
		t.Fatalf("drove %d requests, declared %d: the assertion below would be about a different load", passed, soakRequestCount)
	}

	// ---- settle and compare ---------------------------------------------------------------------
	deadline := time.Now().Add(20 * time.Second)
	for {
		if runtime.NumGoroutine() <= baselineGoroutines+8 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d goroutines remain after %d requests, baseline was %d: a request path is leaking a goroutine.\n%s",
				runtime.NumGoroutine(), soakRequestCount, baselineGoroutines, goroutineStacks(baselineGoroutines+8))
		}
		time.Sleep(100 * time.Millisecond)
	}
	runtime.GC()
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	growth := int64(after.HeapAlloc) - int64(baseline.HeapAlloc)
	t.Logf("after %d requests: %d goroutines, heap %d KiB in use (%+d KiB), %d open files",
		soakRequestCount, runtime.NumGoroutine(), after.HeapAlloc/1024, growth/1024, openFileCount())

	// A GENEROUS BOUND ON PURPOSE. 200 requests through this wiring allocate well under a megabyte of
	// retained state; 4 MiB only fires on per-request accumulation (more than ~20 KiB per request).
	const heapGrowthBound = 4 << 20
	if growth > heapGrowthBound {
		t.Fatalf("the heap grew by %d KiB across %d requests, which is over the %d KiB bound: something is retained per request",
			growth/1024, soakRequestCount, heapGrowthBound/1024)
	}
	if baselineFiles > 0 {
		// Filedescriptors are only countable on a platform that exposes them; -1 means "not measurable
		// here", and asserting on an unmeasurable value is exactly the vacuous check this file avoids.
		finalFiles := openFileCount()
		if finalFiles > baselineFiles+32 {
			t.Fatalf("open files grew from %d to %d across %d requests: a request path is leaking a file or socket",
				baselineFiles, finalFiles, soakRequestCount)
		}
	}
}

// settleGoroutines waits until the goroutine count stops changing for a short window, so the baseline is not
// taken while the warmup's handlers are still finishing.
func settleGoroutines(t *testing.T, window time.Duration) {
	t.Helper()
	deadline := time.Now().Add(window)
	previous := runtime.NumGoroutine()
	stable := 0
	for time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		current := runtime.NumGoroutine()
		if current == previous {
			stable++
			if stable >= 4 {
				return
			}
			continue
		}
		stable = 0
		previous = current
	}
}

// goroutineStacks returns the stacks whose header is NOT a runtime/idle one, so a failure names the leaking
// goroutine instead of printing every scheduler worker.
func goroutineStacks(limit int) string {
	buffer := make([]byte, 1<<20)
	length := runtime.Stack(buffer, true)
	blocks := strings.Split(string(buffer[:length]), "\n\n")
	interesting := make([]string, 0, len(blocks))
	var total int
	for _, block := range blocks {
		if block == "" {
			continue
		}
		total++
		first, _, _ := strings.Cut(block, "\n")
		if strings.Contains(first, "runtime.") || strings.Contains(first, "testing.") || strings.Contains(first, "net/http.(*persistConn)") {
			continue
		}
		interesting = append(interesting, block)
	}
	sort.Strings(interesting)
	if len(interesting) > limit {
		interesting = interesting[:limit]
	}
	return strings.Join(interesting, "\n\n")
}

// openFileCount reports the process's open file descriptors on platforms that expose them, and -1 where the
// number is not measurable (Windows), so the caller can skip rather than assert on a fake zero.
func openFileCount() int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return -1
	}
	return len(entries)
}
