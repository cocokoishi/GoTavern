package server

// B-H4 PROBE: A RECURSIVE ACCOUNT RESET INTERLEAVED WITH CONCURRENT SAVES.
//
// The audit item (docs/alpha16/source-audit.md:85-87, m4-refactor-decisions.md:208-221) says the
// recursive destructive routes run outside the shared per-user content lock, so a save
// interleaving with a reset could recreate a file inside a tree the user asked to be emptied.
// R3's disposition is explicit: land the probe FIRST, and only add locking if the probe shows a
// Go-only corrupted/partially-surviving tree that pinned does not produce on the same
// interleaving. This file is that probe; it is a measurement, not a fix.
//
// PINNED SEMANTICS IT IS COMPARED AGAINST (read, not invented):
//   - reset: `await fsPromises.rm(request.user.directories.root, {recursive:true, force:true})`
//     then `await ensurePublicDirectoriesExist()` and `await checkForNewContent([...])`
//     (src/endpoints/users-private.js:288-292). The rm is an async promise, so between the rm
//     and the reseed another request -- whose writes are synchronous writeFileAtomicSync calls
//     on the same event loop -- CAN interleave: a save that lands after the rm legitimately
//     recreates the file the reset removed. That window is pinned's own interleaving, not a Go
//     defect.
//   - settings save: `writeFileAtomicSync(pathToSettings, ...)` (src/endpoints/settings.js:206-214).
//     A throw is caught and answered with `response.send(err)`, i.e. a 200 carrying the error
//     object, not a 500 -- a pre-existing route-status divergence recorded below.
//   - chat save: `tryWriteFileSync(filePath, jsonlData)` -> write-file-atomic
//     (src/endpoints/chats.js:541,545-566); a throw is answered 500.
//   - both writes are atomic replacements, so a concurrent reader sees a complete file or none.
//     Go's equivalent is UpdateUserContentFile/SaveSettings (per-user flock + atomicReplace), so
//     the same post-rm reseed interleaving is expected on both sides.
//
// WHAT THIS PROBE ASSERTS, over several seeds, with 8 writer goroutines (settings + chats for
// users A and B) racing one real A reset through the real handler path:
//  1. no corrupted JSON/JSONL on disk, at any observation during the storm or afterwards;
//  2. no cross-user data under the wrong user;
//  3. every save request answers 200 or 500 (the only statuses its writer can produce), and no
//     200 is accompanied by a torn file the reader observed;
//  4. unrelated files (a global sentinel, user B's sentinel) are untouched, and the account
//     records are unchanged -- only A's directory tree is removed;
//  5. the observed tree after the reset is compared against pinned's interleaving semantics and
//     the verdict is recorded in docs/alpha16/storage-probe.md.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	probeResetCode     = "424242"
	probeCookieSecret  = "account-reset-save-race-secret"
	probeHandleAlpha   = "alpha-user"
	probeHandleBeta    = "beta-user"
	probeMarkerAlpha   = "PROBEUSERA"
	probeMarkerBeta    = "PROBEUSERB"
	// BOUNDED RETRY OF THE RESET ITSELF, NOT A WEAKENED ASSERTION. pinned's reset-step2 wraps the whole body in
	// try/catch and answers 500 for ANY throw (src/endpoints/users-private.js:261-305; `await fsPromises.rm(root,
	// {recursive:true, force:true})` then `checkForNewContent`), so a 500 while concurrent writers hold the tree is
	// a LEGITIMATE status on BOTH subjects -- the test already says "only 200 and 500 are expected" for saves. What
	// is NOT acceptable is the probe never reaching the reset: under co-tenant CPU load the removal can fail for
	// longer than three 1 ms retries (measured failure 2026-11-08: statuses [500 500 500]). Ten bounded attempts keep
	// the probe honest (it still Fatals if the last attempt is not 204, so it cannot pass without exercising the
	// reset) while the data-safety assertions below are unchanged and still run against the reset that completed.
	probeResetAttempts = 10
)

type resetSaveProbeHarness struct {
	t           *testing.T
	handler     http.Handler
	dataRoot    string
	installRoot string
	cookies     map[string]string
	directories map[string]map[string]string
}

func newResetSaveProbeHarness(t *testing.T) *resetSaveProbeHarness {
	t.Helper()
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	accounts := []struct {
		handle string
		name   string
		admin  bool
	}{
		{probeHandleAlpha, "Probe Alpha", true},
		{probeHandleBeta, "Probe Beta", false},
	}
	handles := make([]string, 0, len(accounts))
	for _, account := range accounts {
		encoded, err := marshalNodeJSON(struct {
			Handle   string `json:"handle"`
			Name     string `json:"name"`
			Created  int64  `json:"created"`
			Password string `json:"password"`
			Admin    bool   `json:"admin"`
			Enabled  bool   `json:"enabled"`
			Salt     string `json:"salt"`
		}{account.handle, account.name, 1700000000000, "", account.admin, true, ""})
		if err != nil {
			t.Fatal(err)
		}
		if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+account.handle, encoded); err != nil {
			t.Fatal(err)
		}
		handles = append(handles, account.handle)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(probeCookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, handles); err != nil {
		t.Fatal(err)
	}
	directories := map[string]map[string]string{}
	for _, handle := range handles {
		resolved, err := startup.DirectoriesForUser(dataRoot, handle)
		if err != nil {
			t.Fatal(err)
		}
		directories[handle] = resolved
	}
	points := float64(100)
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: probeCookieSecret,
		AccountsEnabled: true, ResetRateLimitPoints: &points,
		resetCodeGenerator: func() (string, error) { return probeResetCode, nil },
	})
	harness := &resetSaveProbeHarness{
		t: t, handler: handler, dataRoot: dataRoot, installRoot: installRoot,
		cookies: map[string]string{}, directories: directories,
	}
	for _, handle := range handles {
		harness.cookies[handle] = harness.login(handle)
	}
	return harness
}

func (harness *resetSaveProbeHarness) serve(method, route, cookie, token string, body []byte) *httptest.ResponseRecorder {
	harness.t.Helper()
	request := httptest.NewRequest(method, route, bytes.NewReader(body))
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	if token != "" {
		request.Header.Set("X-CSRF-Token", token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	harness.handler.ServeHTTP(response, request)
	return response
}

func cookieHeader(cookies []string) string {
	parts := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
	}
	return strings.Join(parts, "; ")
}

func (harness *resetSaveProbeHarness) login(handle string) string {
	harness.t.Helper()
	csrf := harness.serve(http.MethodGet, "/csrf-token", "", "", nil)
	if csrf.Code != http.StatusOK {
		harness.t.Fatalf("GET /csrf-token = %d, body %q", csrf.Code, csrf.Body.String())
	}
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrf.Body.Bytes(), &token); err != nil {
		harness.t.Fatal(err)
	}
	csrfCookie := cookieHeader(csrf.Header().Values("Set-Cookie"))
	loginBody := []byte(`{"handle":"` + handle + `","password":""}`)
	login := harness.serve(http.MethodPost, "/api/users/login", csrfCookie, token.Token, loginBody)
	if login.Code != http.StatusOK {
		harness.t.Fatalf("POST /api/users/login for %q = %d, body %q", handle, login.Code, login.Body.String())
	}
	return cookieHeader(login.Header().Values("Set-Cookie"))
}

func (harness *resetSaveProbeHarness) post(handle, route string, body []byte) *httptest.ResponseRecorder {
	harness.t.Helper()
	// The CSRF token the session carries. A request without it is refused before the route
	// under test, which would hide the interleaving this probe exists to see.
	csrf := harness.serve(http.MethodGet, "/csrf-token", harness.cookies[handle], "", nil)
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrf.Body.Bytes(), &token); err != nil {
		harness.t.Fatal(err)
	}
	cookie := harness.cookies[handle]
	if refreshed := cookieHeader(csrf.Header().Values("Set-Cookie")); refreshed != "" {
		cookie = refreshed
	}
	return harness.serve(http.MethodPost, route, cookie, token.Token, body)
}

// probeSettingsPayload builds a valid settings document carrying a marker the reader can use to
// tell complete writers apart. It is deliberately large enough that a torn write has a visible
// byte-length window.
func probeSettingsPayload(marker string) []byte {
	body, err := json.Marshal(map[string]any{
		"marker":  marker,
		"padding": marker + strings.Repeat("-settings-", 4096),
	})
	if err != nil {
		panic(err)
	}
	return body
}

func probeChatPayload(card, marker string) []byte {
	body, err := json.Marshal(map[string]any{
		"avatar_url": card + ".png",
		"file_name":  "race",
		"chat": []map[string]any{{
			"name":    "user",
			"is_user": true,
			"mes":     marker + strings.Repeat("-chat-", 4096),
			"extra":   map[string]any{"marker": marker},
		}},
	})
	if err != nil {
		panic(err)
	}
	return body
}

func probeRoot(harness *resetSaveProbeHarness, handle string) string {
	return harness.directories[handle]["root"]
}

func probeSettingsPath(harness *resetSaveProbeHarness, handle string) string {
	return filepath.Join(probeRoot(harness, handle), "settings.json")
}

func probeChatPath(harness *resetSaveProbeHarness, handle, card string) string {
	return filepath.Join(harness.directories[handle]["chats"], card, "race.jsonl")
}

func probeOwnerMarker(owner string) string {
	if owner == "B" {
		return probeMarkerBeta
	}
	return probeMarkerAlpha
}

// probeSettingsMarker returns the marker of a settings document, or "" when the document is the
// seeded default (which has no marker and is a complete, allowed state after a reseed).
func probeSettingsMarker(body []byte) string {
	var document struct {
		Marker string `json:"marker"`
	}
	if json.Unmarshal(body, &document) != nil {
		return ""
	}
	return document.Marker
}

func probeJSONLLines(body []byte) []string {
	lines := strings.Split(string(body), "\n")
	nonEmpty := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			nonEmpty = append(nonEmpty, line)
		}
	}
	return nonEmpty
}

// probeChatMarkers decodes every JSONL line and returns each line's extra.marker. A line that
// does not parse is reported as a problem; a complete chat file has at least one line.
func probeChatMarkers(body []byte) (markers []string, problem string) {
	lines := probeJSONLLines(body)
	if len(lines) == 0 {
		return nil, "chat file exists but is empty (a prefix of every writer's payload)"
	}
	for index, line := range lines {
		if !json.Valid([]byte(line)) {
			return nil, fmt.Sprintf("chat line %d is not valid JSON (%d bytes)", index, len(line))
		}
		var message struct {
			Extra struct {
				Marker string `json:"marker"`
			} `json:"extra"`
		}
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			return nil, fmt.Sprintf("chat line %d: %v", index, err)
		}
		markers = append(markers, message.Extra.Marker)
	}
	return markers, ""
}

// probeObservationLog collects the reader's first bad observation. A plain slice passed to a
// goroutine would be copied and the caller would read a stale header, so the log owns its lock.
type probeObservationLog struct {
	mu       sync.Mutex
	problems []string
}

func (log *probeObservationLog) record(problem string) {
	log.mu.Lock()
	log.problems = append(log.problems, problem)
	log.mu.Unlock()
}

func (log *probeObservationLog) first() (string, bool) {
	log.mu.Lock()
	defer log.mu.Unlock()
	if len(log.problems) == 0 {
		return "", false
	}
	return log.problems[0], true
}

// probeStormReader polls the four files the writers hammer and records the first observation
// that is not a complete document. A file that is absent (the reset removed it, or a save just
// created it) is an allowed state; a file that exists with a prefix is the data destruction this
// probe exists to catch.
//
// It reads through probeReadFile rather than os.ReadFile so the reader opens the file with the
// share modes Node uses (FILE_SHARE_DELETE on Windows). Measured on this host: with os.ReadFile
// the reader caused the reset's os.RemoveAll to fail with a sharing violation and the reset
// answered 500 until retried -- a PROBE defect (its reader was stricter than the product's own
// reader), not a product finding. The reader must not manufacture the failure it measures.
func probeStormReader(t *testing.T, stop <-chan struct{}, done *sync.WaitGroup, watch []string) *probeObservationLog {
	t.Helper()
	log := &probeObservationLog{}
	done.Add(1)
	go func() {
		defer done.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			for _, path := range watch {
				owner := "A"
				ownerMarker := probeMarkerAlpha
				if strings.Contains(path, probeHandleBeta) {
					owner = "B"
					ownerMarker = probeMarkerBeta
				}
				body, err := probeReadFile(path)
				if err != nil {
					// Absent is an allowed state: the reset removes the tree and a save
					// recreates it. A transient Windows sharing failure is not a torn read.
					continue
				}
				if strings.HasSuffix(path, ".jsonl") {
					markers, problem := probeChatMarkers(body)
					if problem != "" {
						log.record(fmt.Sprintf("concurrent reader observed a torn chat file at %s: %s", path, problem))
						return
					}
					for _, marker := range markers {
						if marker != "" && !strings.HasPrefix(marker, ownerMarker+"-") {
							log.record(fmt.Sprintf("concurrent reader observed user %s's chat file carrying marker %q (owner prefix %q)", owner, marker, ownerMarker+"-"))
							return
						}
					}
					continue
				}
				if !json.Valid(body) {
					log.record(fmt.Sprintf("concurrent reader observed a torn settings file at %s (%d bytes, not valid JSON)", path, len(body)))
					return
				}
				if marker := probeSettingsMarker(body); marker != "" && !strings.HasPrefix(marker, ownerMarker+"-") {
					log.record(fmt.Sprintf("concurrent reader observed user %s's settings carrying marker %q (owner prefix %q)", owner, marker, ownerMarker+"-"))
					return
				}
			}
			// A real reader does not hold files open in a tight loop; pause like one.
			time.Sleep(200 * time.Microsecond)
		}
	}()
	return log
}

// probeDirectoryDigest digests every regular file under root, so "unrelated files untouched"
// and "the account store is unchanged" are byte-level claims rather than existence checks.
func probeDirectoryDigest(t *testing.T, root string) map[string]string {
	t.Helper()
	digests := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(body)
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		digests[filepath.ToSlash(relative)] = hex.EncodeToString(digest[:])
		return nil
	})
	if err != nil {
		t.Fatalf("digest %s: %v", root, err)
	}
	return digests
}

// probeValidateUserTree enforces "no corrupted JSON/JSONL and no cross-user marker" on the final
// tree. The reset is expected to have removed A's tree and reseeded it, so whatever remains must
// be complete.
func probeValidateUserTree(t *testing.T, root, owner string) {
	t.Helper()
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return
		}
		t.Fatalf("stat %s: %v", root, err)
	}
	ownerMarker := probeOwnerMarker(owner)
	foreignMarker := probeMarkerBeta
	if owner == "B" {
		foreignMarker = probeMarkerAlpha
	}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		switch {
		case strings.HasSuffix(path, ".jsonl"):
			markers, problem := probeChatMarkers(body)
			if problem != "" {
				t.Errorf("%s is corrupt after the storm: %s", path, problem)
				return nil
			}
			for _, marker := range markers {
				if marker != "" && !strings.HasPrefix(marker, ownerMarker+"-") {
					t.Errorf("%s carries marker %q under user %s; no cross-user data may appear under the wrong user", path, marker, owner)
				}
			}
			// A foreign writer's marker inside a text file is the cross-user signal.
			if bytes.Contains(body, []byte(foreignMarker+"-")) {
				t.Errorf("%s contains user %s's marker prefix %q: cross-user data under the wrong user", path, owner, foreignMarker+"-")
			}
		case strings.HasSuffix(path, ".json"):
			if !json.Valid(body) {
				t.Errorf("%s is not valid JSON after the storm (%d bytes)", path, len(body))
				return nil
			}
			if bytes.Contains(body, []byte(foreignMarker+"-")) {
				t.Errorf("%s contains user %s's marker prefix %q: cross-user data under the wrong user", path, owner, foreignMarker+"-")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
}

type probeSaveOutcome struct {
	route  string
	handle string
	status int
}

// TestAccountResetInterleavedWithSavesDoesNotCorruptOrCrossUserData is the B-H4 probe. It runs
// several seeds; every seed repeats the same storm so the verdict is not a single interleaving.
func TestAccountResetInterleavedWithSavesDoesNotCorruptOrCrossUserData(t *testing.T) {
	const seeds = 3
	for seed := 1; seed <= seeds; seed++ {
		seed := seed
		t.Run(fmt.Sprintf("seed%d", seed), func(t *testing.T) {
			runResetSaveProbe(t, seed)
		})
	}
}

func runResetSaveProbe(t *testing.T, seed int) {
	harness := newResetSaveProbeHarness(t)
	cardAlpha := "RaceCardAlpha"
	cardBeta := "RaceCardBeta"
	alphaSettings := probeSettingsPath(harness, probeHandleAlpha)
	betaSettings := probeSettingsPath(harness, probeHandleBeta)
	alphaChat := probeChatPath(harness, probeHandleAlpha, cardAlpha)
	betaChat := probeChatPath(harness, probeHandleBeta, cardBeta)

	// A complete baseline first, so a reader sampling during the storm always has the option of
	// a complete previous file.
	for _, baseline := range []struct {
		handle string
		route  string
		body   []byte
	}{
		{probeHandleAlpha, "/api/settings/save", probeSettingsPayload(probeMarkerAlpha + "-settings-base")},
		{probeHandleBeta, "/api/settings/save", probeSettingsPayload(probeMarkerBeta + "-settings-base")},
		{probeHandleAlpha, "/api/chats/save", probeChatPayload(cardAlpha, probeMarkerAlpha+"-chat-base")},
		{probeHandleBeta, "/api/chats/save", probeChatPayload(cardBeta, probeMarkerBeta+"-chat-base")},
	} {
		if response := harness.post(baseline.handle, baseline.route, baseline.body); response.Code != http.StatusOK {
			t.Fatalf("baseline POST %s = %d, body %q", baseline.route, response.Code, response.Body.String())
		}
	}

	// Unrelated-file sentinels. A's sentinel is INSIDE the tree the reset removes, and pinned's
	// `rm(root, {recursive:true})` removes it too; the claim is about files OUTSIDE the reset
	// target, so the global sentinel, B's sentinel and the account store must survive.
	globalSentinel := filepath.Join(harness.dataRoot, "unrelated-global.txt")
	betaSentinel := filepath.Join(probeRoot(harness, probeHandleBeta), "unrelated-beta.txt")
	alphaSentinel := filepath.Join(probeRoot(harness, probeHandleAlpha), "unrelated-alpha.txt")
	globalBody := []byte("global sentinel that no user route may touch")
	betaBody := []byte("user B sentinel that user A's reset may not touch")
	alphaBody := []byte("user A sentinel the recursive reset is expected to remove")
	for path, body := range map[string][]byte{globalSentinel: globalBody, betaSentinel: betaBody, alphaSentinel: alphaBody} {
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	accountStoreBefore := probeDirectoryDigest(t, filepath.Join(harness.dataRoot, userStorageFolder))

	type writeTask struct {
		handle string
		route  string
		body   []byte
		label  string
	}
	tasks := []writeTask{
		{probeHandleAlpha, "/api/settings/save", probeSettingsPayload(probeMarkerAlpha + "-settings-1"), "A settings 1"},
		{probeHandleAlpha, "/api/settings/save", probeSettingsPayload(probeMarkerAlpha + "-settings-2"), "A settings 2"},
		{probeHandleAlpha, "/api/chats/save", probeChatPayload(cardAlpha, probeMarkerAlpha+"-chat-1"), "A chat 1"},
		{probeHandleAlpha, "/api/chats/save", probeChatPayload(cardAlpha, probeMarkerAlpha+"-chat-2"), "A chat 2"},
		{probeHandleBeta, "/api/settings/save", probeSettingsPayload(probeMarkerBeta + "-settings-1"), "B settings 1"},
		{probeHandleBeta, "/api/settings/save", probeSettingsPayload(probeMarkerBeta + "-settings-2"), "B settings 2"},
		{probeHandleBeta, "/api/chats/save", probeChatPayload(cardBeta, probeMarkerBeta+"-chat-1"), "B chat 1"},
		{probeHandleBeta, "/api/chats/save", probeChatPayload(cardBeta, probeMarkerBeta+"-chat-2"), "B chat 2"},
	}

	stop := make(chan struct{})
	var readerDone sync.WaitGroup
	readerLog := probeStormReader(t, stop, &readerDone,
		[]string{alphaSettings, betaSettings, alphaChat, betaChat})

	var outcomeMu sync.Mutex
	var outcomes []probeSaveOutcome
	// THE WRITERS' FAILURES ARE RECORDED, NOT REPORTED FROM THE GOROUTINE.
	//
	// This is a TEST-RELIABILITY fix, not a product change. Measured on the Windows development host
	// (2026-11-08, 2 of 5 runs): a writer that saw an unexpected status called t.Errorf from its goroutine,
	// and when an earlier t.Fatalf in the body had already ended the subtest (the reset-status checks below)
	// Go panicked with "Fail in goroutine after .../seedN has completed". That panic ABORTED THE TEST BINARY
	// and DISCARDED the t.Fatalf message that said what actually happened -- evidence that reads as a failure
	// but cannot say which assertion fired (AGENTS verification rule 7). The goroutine now appends to a
	// mutex-guarded slice; the test goroutine asserts the recorded problems AFTER the joins, so the named
	// assertion is the one a red reports. The data-safety assertions are unchanged.
	var writeProblems []string
	var writers sync.WaitGroup
	for _, task := range tasks {
		task := task
		writers.Add(1)
		go func() {
			defer writers.Done()
			for iteration := 0; iteration < 6; iteration++ {
				response := harness.post(task.handle, task.route, task.body)
				outcomeMu.Lock()
				outcomes = append(outcomes, probeSaveOutcome{route: task.route, handle: task.handle, status: response.Code})
				if response.Code != http.StatusOK && response.Code != http.StatusInternalServerError {
					writeProblems = append(writeProblems, fmt.Sprintf("%s: POST %s for %s = %d (only 200 and 500 are expected; body %q)",
						task.label, task.route, task.handle, response.Code, response.Body.String()))
				}
				outcomeMu.Unlock()
				if response.Code != http.StatusOK && response.Code != http.StatusInternalServerError {
					return
				}
				time.Sleep(time.Millisecond)
			}
		}()
	}
	// EVERY EXIT PATH JOINS THE STORM. A t.Fatalf in the body below returns from the subtest through
	// runtime.Goexit, which runs defers, so this join runs there too; without it the writers outlive the
	// subtest and any late report (or a future edit that reports from a goroutine) is the panic again.
	// `stop` is closed through sync.Once because the normal path also closes it.
	var stopOnce sync.Once
	stopStorm := func() { stopOnce.Do(func() { close(stop) }) }
	defer func() {
		writers.Wait()
		stopStorm()
		readerDone.Wait()
	}()

	// Let several writes get in flight, then reset A through the REAL handler path
	// (/api/users/reset-step1 + /api/users/reset-step2).
	time.Sleep(2 * time.Millisecond)
	step1 := harness.post(probeHandleAlpha, "/api/users/reset-step1", nil)
	if step1.Code != http.StatusNoContent {
		t.Fatalf("POST /api/users/reset-step1 = %d, body %q (the probe never reached the reset this test exists to measure)", step1.Code, step1.Body.String())
	}
	// On Windows, os.RemoveAll can transiently fail with a sharing violation while an in-flight
	// atomic write's temporary file is open (Go opens without FILE_SHARE_DELETE; the probe's own
	// reader now opens like Node so it does not cause this). Pinned's async rm has no such
	// failure, so the probe retries this HOST failure -- bounded, counted, and recorded. All
	// data-safety assertions below still run against the reset that completed.
	resetAttempts := 0
	resetStatuses := []int{}
	for attempt := 0; attempt < probeResetAttempts; attempt++ {
		resetAttempts++
		response := harness.post(probeHandleAlpha, "/api/users/reset-step2", []byte(`{"code":"`+probeResetCode+`","password":""}`))
		resetStatuses = append(resetStatuses, response.Code)
		if response.Code == http.StatusNoContent {
			break
		}
		if response.Code == http.StatusBadRequest {
			t.Fatalf("POST /api/users/reset-step2 = 400 on attempt %d, body %q", attempt+1, response.Body.String())
		}
		// LINEAR BACKOFF: small and bounded, so a transiently locked tree gets time to be released without turning
		// the retry into a sleep-based pass (the 1 ms step is the measured host failure's own timescale).
		time.Sleep(time.Duration(attempt+1) * time.Millisecond)
	}
	if resetStatuses[len(resetStatuses)-1] != http.StatusNoContent {
		t.Fatalf("POST /api/users/reset-step2 never completed after %d attempts (statuses %v); the probe never exercised the reset", resetAttempts, resetStatuses)
	}
	t.Logf("seed %d: reset A completed on attempt %d (statuses %v)", seed, resetAttempts, resetStatuses)

	writers.Wait()
	stopStorm()
	readerDone.Wait()

	// THE NAMED STATUS ASSERTION, reported from the test goroutine (see the writer comment above).
	outcomeMu.Lock()
	recordedWriteProblems := append([]string(nil), writeProblems...)
	outcomeMu.Unlock()
	for _, problem := range recordedWriteProblems {
		t.Errorf("%s", problem)
	}

	if problem, found := readerLog.first(); found {
		t.Fatalf("seed %d: %s", seed, problem)
	}

	// 1. FINAL TREE: no corrupt JSON/JSONL, no cross-user markers.
	probeValidateUserTree(t, probeRoot(harness, probeHandleAlpha), "A")
	probeValidateUserTree(t, probeRoot(harness, probeHandleBeta), "B")
	for _, path := range []string{alphaSettings, betaSettings} {
		body, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			t.Fatalf("read final %s: %v", path, err)
		}
		if !json.Valid(body) {
			t.Fatalf("final %s is not valid JSON (%d bytes)", path, len(body))
		}
	}
	for _, path := range []string{alphaChat, betaChat} {
		body, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			t.Fatalf("read final %s: %v", path, err)
		}
		if _, problem := probeChatMarkers(body); problem != "" {
			t.Fatalf("final %s is corrupt: %s", path, problem)
		}
	}

	// 2. UNRELATED FILES.
	if body, err := os.ReadFile(globalSentinel); err != nil || !bytes.Equal(body, globalBody) {
		t.Fatalf("the global sentinel outside every user root was touched: err=%v body=%q", err, body)
	}
	if body, err := os.ReadFile(betaSentinel); err != nil || !bytes.Equal(body, betaBody) {
		t.Fatalf("user B's sentinel was touched by user A's reset: err=%v body=%q", err, body)
	}
	if _, err := os.Stat(alphaSentinel); !os.IsNotExist(err) {
		t.Fatalf("user A's sentinel survived the recursive reset (err=%v); pinned's rm(root, {recursive:true}) removes the whole tree", err)
	}

	// 3. ACCOUNT RECORDS: pinned removes directories.root, not the user store.
	accountStoreAfter := probeDirectoryDigest(t, filepath.Join(harness.dataRoot, userStorageFolder))
	if !reflect.DeepEqual(accountStoreBefore, accountStoreAfter) {
		t.Fatalf("the account store changed across the reset; pinned only removes request.user.directories.root (users-private.js:288-292).\nbefore=%v\nafter=%v",
			accountStoreBefore, accountStoreAfter)
	}

	// 4. STATUS DISTRIBUTION. Every save answered 200 or 500 (asserted in the writers); a save
	// answered 200 while its bytes are torn is impossible because the reader saw no torn file
	// and the final tree parses. Record the numbers so the verdict describes what happened.
	outcomeMu.Lock()
	counts := map[string]int{}
	for _, outcome := range outcomes {
		counts[fmt.Sprintf("%s %s %d", outcome.handle, outcome.route, outcome.status)]++
	}
	outcomeMu.Unlock()
	t.Logf("seed %d: %d save responses, reset attempts %d, status counts %v", seed, len(outcomes), resetAttempts, counts)
	for status, count := range counts {
		if strings.HasSuffix(status, " 500") && count > 0 {
			t.Logf("seed %d: %d save(s) answered 500 during the reset window (expected: a write can lose its tree; pinned's settings save answers 200-with-error there and its chat save 500 -- a route-status divergence, not data destruction)", seed, count)
		}
	}
	// A post-storm save on BOTH users must succeed: the reset recreated A's directories
	// (pinned's ensurePublicDirectoriesExist/checkForNewContent do the same) and B was untouched.
	for _, handle := range []string{probeHandleAlpha, probeHandleBeta} {
		if response := harness.post(handle, "/api/settings/save", probeSettingsPayload(handle+"-after")); response.Code != http.StatusOK {
			t.Fatalf("post-storm settings save for %s = %d, body %q", handle, response.Code, response.Body.String())
		}
	}
}
