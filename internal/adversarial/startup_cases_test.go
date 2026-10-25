package adversarial

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/server"
	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/internal/tokenizers"
	"github.com/gofrs/flock"
)

func listenerURL(listener net.Listener) string {
	host, port, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		return "http://" + listener.Addr().String()
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// dataStartupOptions pins every input of the chain a case is not measuring, so
// an adversary cannot depend on the runner's clock or on the real ten-second
// legacy warning (that delay has its own case).
func dataStartupOptions(installRoot, dataRoot string) startup.DataStartupOptions {
	return startup.DataStartupOptions{
		InstallRoot:              installRoot,
		DataRoot:                 dataRoot,
		Now:                      time.Now(),
		WaitBeforeLegacyDataMove: noLegacyWait,
	}
}

func startupCases(t *testing.T) []caseSpec {
	t.Helper()

	// 1. $HOME pointing at a directory that cannot exist, in global mode.
	missingHomeParent := t.TempDir()
	writeText(t, filepath.Join(missingHomeParent, "blocked"), "a file where a directory must be")
	missingHome := filepath.Join(missingHomeParent, "blocked", "nested")
	missingHomeInstall := t.TempDir()
	missingHomeWork := t.TempDir()
	missingHomePort := freePort(t)

	// 2. A read-only install root: the shape of a container image whose /app is
	// not writable by the runtime user.
	readOnlyInstall := t.TempDir()
	readOnlyData := t.TempDir()
	readOnlyWork := t.TempDir()
	readOnlyPort := freePort(t)

	// 3/4. Foreign CWD: the config is resolved from the working directory while
	// the runtime tree is the install root.
	foreignInstall := t.TempDir()
	foreignWork := t.TempDir()
	foreignData := t.TempDir()
	writeText(t, filepath.Join(foreignInstall, "config.yaml"), "listen: false\nport: 8000\n")
	writeText(t, filepath.Join(foreignWork, "config.yaml"), "listen: false\nport: 8000\ndataRoot: \"./data\"\n")
	foreignAbsolutePort := freePort(t)
	foreignRelativePort := freePort(t)

	// 5. A port already bound by another process (the user's working `node server.js`).
	boundListener, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Fatalf("occupy a port: %v", err)
	}
	boundPort := boundListener.Addr().(*net.TCPAddr).Port
	t.Cleanup(func() { _ = boundListener.Close() })
	boundInstall, boundWork, boundData := t.TempDir(), t.TempDir(), t.TempDir()

	// 6. Missing public/**: the frontend is embedded, so a release without the
	// directory must still serve.
	noPublicInstall := t.TempDir()
	noPublicWork, noPublicData := t.TempDir(), t.TempDir()
	noPublicPort := freePort(t)

	// 7. Missing tokenizers/**: the routes silently estimate today.
	tokenizerHandler := server.NewHTTPHandlerWithOptions(server.HTTPHandlerOptions{
		InstallRoot: t.TempDir(),
		DataRoot:    t.TempDir(),
		DisableCSRF: true,
	})

	// 8. Two boots of one tree at once.
	concurrentInstall, concurrentData := t.TempDir(), t.TempDir()

	// 9. A second boot while the first holds a data-startup lock.
	lockInstall, lockData := t.TempDir(), t.TempDir()

	// 10. A legacy tree: public/characters is the only trigger for the ten-second
	// warning and the move (internal/startup/user_data_migration.go:34,40).
	legacyInstall := t.TempDir()
	legacyData, legacyWork := t.TempDir(), t.TempDir()
	writeText(t, filepath.Join(legacyInstall, "public", "characters", "Alice.png"), "not really a png")
	legacyPort := freePort(t)

	// 11. An absolute data root whose parents do not exist.
	deepDataParent := t.TempDir()
	deepDataRoot := filepath.Join(deepDataParent, "absent", "nested", "data")
	deepInstall, deepWork := t.TempDir(), t.TempDir()
	deepPort := freePort(t)

	return []caseSpec{
		{
			id:        "boot.missing-home",
			checklist: "home.missing",
			invariant: "a $HOME that cannot exist fails with a named error inside a bound; it may not hang or crash (rule 24/35)",
			run: func() caseResult {
				previous, had := os.LookupEnv("HOME")
				if err := os.Setenv("HOME", missingHome); err != nil {
					return violation("set HOME: %v", err)
				}
				defer func() {
					if had {
						_ = os.Setenv("HOME", previous)
					} else {
						_ = os.Unsetenv("HOME")
					}
				}()
				running, startErr := startProductGlobal(missingHomeInstall, missingHomeWork, missingHomePort)
				if startErr == nil {
					_ = running.Close(context.Background())
					return violation("boot with a non-existent $HOME (%s) reportedly succeeded", missingHome)
				}
				if !strings.Contains(startErr.Error(), missingHome) && !strings.Contains(startErr.Error(), "not a directory") &&
					!strings.Contains(startErr.Error(), "no such file") {
					return violation("the error does not name the cause: %v", startErr)
				}
				return okResult("refused with %v", startErr)
			},
		},
		{
			id:        "boot.readonly-install-root",
			checklist: "install.readonly",
			invariant: "a read-only install root either boots or fails with an error naming the path it could not create; it may not hang or panic (rule 24/34)",
			run: func() caseResult {
				if err := os.Chmod(readOnlyInstall, 0o555); err != nil {
					return violation("chmod the install root: %v", err)
				}
				defer func() { _ = os.Chmod(readOnlyInstall, 0o755) }()
				if probeErr := os.WriteFile(filepath.Join(readOnlyInstall, ".write-probe"), []byte("probe"), 0o644); probeErr == nil {
					_ = os.Remove(filepath.Join(readOnlyInstall, ".write-probe"))
					return notApplicable("the read-only install root is still writable for this process, so the case cannot discriminate")
				}
				running, startErr := startProduct(readOnlyInstall, readOnlyWork, readOnlyData, readOnlyPort, noLegacyWait)
				if startErr == nil {
					closeErr := running.Close(context.Background())
					return okResult("booted; close returned %v", closeErr)
				}
				if !strings.Contains(startErr.Error(), readOnlyInstall) && !strings.Contains(startErr.Error(), "permission denied") {
					return violation("the failure does not name the unwritable path: %v", startErr)
				}
				return okResult("refused with %v", startErr)
			},
		},
		{
			id:        "boot.foreign-cwd-absolute-data-root",
			checklist: "cwd.foreign",
			invariant: "booting from a foreign CWD must not modify the install tree's config (rule 27/28)",
			run: func() caseResult {
				installConfig := filepath.Join(foreignInstall, "config.yaml")
				before, err := os.ReadFile(installConfig)
				if err != nil {
					return violation("read the install tree's config: %v", err)
				}
				running, startErr := startProduct(foreignInstall, foreignWork, foreignData, foreignAbsolutePort, noLegacyWait)
				if startErr != nil {
					return violation("boot from a foreign CWD with an absolute data root failed: %v", startErr)
				}
				_ = running.Close(context.Background())
				after, err := os.ReadFile(installConfig)
				if err != nil {
					return violation("the install tree's config became unreadable: %v", err)
				}
				if string(before) != string(after) {
					return violation("boot from a foreign CWD rewrote %s", installConfig)
				}
				return okResult("booted; install-tree config untouched")
			},
		},
		{
			id:        "boot.foreign-cwd-relative-data-root",
			checklist: "cwd.foreign",
			invariant: "the data directory a boot CREATES must be the data directory it USES; a relative dataRoot resolved against two different roots is a boot that cannot succeed",
			run: func() caseResult {
				running, startErr := startProductArgs(foreignInstall, foreignWork, foreignRelativePort, noLegacyWait)
				createdInWork := filepath.Join(foreignWork, "data")
				usedInInstall := filepath.Join(foreignInstall, "data")
				_, createdErr := os.Stat(createdInWork)
				_, usedErr := os.Stat(usedInInstall)
				created := createdErr == nil
				used := usedErr == nil
				if startErr == nil {
					_ = running.Close(context.Background())
					return okResult("booted (created-in-CWD=%t, present-in-install=%t)", created, used)
				}
				if created && !used {
					return violation("boot created %s and then failed using %s, which it never created: %v", createdInWork, usedInInstall, startErr)
				}
				if !strings.Contains(startErr.Error(), "data") && !strings.Contains(startErr.Error(), "cookie") &&
					!strings.Contains(startErr.Error(), "secret") {
					return violation("the failure does not name the data root: %v", startErr)
				}
				return okResult("refused with %v", startErr)
			},
		},
		{
			id:        "boot.port-already-bound",
			checklist: "port.bound",
			invariant: "a port owned by another process (the user's working `node server.js`) is reported as a named listener failure inside a bound",
			run: func() caseResult {
				running, startErr := startProduct(boundInstall, boundWork, boundData, boundPort, noLegacyWait)
				if startErr == nil {
					_ = running.Close(context.Background())
					return violation("boot reported success although port %d is already bound by another listener", boundPort)
				}
				if !strings.Contains(startErr.Error(), "address already in use") && !strings.Contains(startErr.Error(), fmt.Sprint(boundPort)) {
					return violation("the failure does not name the port: %v", startErr)
				}
				return okResult("refused with %v", startErr)
			},
		},
		{
			id:        "boot.missing-public",
			checklist: "public.missing",
			invariant: "a release layout without public/** must still serve the frontend from the embedded assets (rule 23/34)",
			run: func() caseResult {
				running, startErr := startProduct(noPublicInstall, noPublicWork, noPublicData, noPublicPort, noLegacyWait)
				if startErr != nil {
					return violation("boot without public/** failed: %v", startErr)
				}
				defer func() { _ = running.Close(context.Background()) }()
				if len(running.Listeners()) == 0 {
					return violation("boot returned no listener")
				}
				client := &http.Client{Timeout: 10 * time.Second}
				response, err := client.Get(listenerURL(running.Listeners()[0]) + "/")
				if err != nil {
					return violation("GET / failed: %v", err)
				}
				defer func() { _ = response.Body.Close() }()
				body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
				if response.StatusCode != http.StatusOK {
					return violation("GET / answered %d without public/**: %s", response.StatusCode, strings.TrimSpace(string(body)))
				}
				return okResult("GET / answered 200 from the embedded assets")
			},
		},
		{
			id:        "boot.missing-tokenizers",
			checklist: "tokenizers.missing",
			invariant: "rule 9: without a tokenizer tree the routes must not answer 200 with a Guesstimate count; an inexact answer has to be visible, not silent",
			run: func() caseResult {
				const text = "hello"
				request := httptest.NewRequest(http.MethodPost, "/api/tokenizers/llama/encode", strings.NewReader(`{"text":"`+text+`"}`))
				request.Header.Set("Content-Type", "application/json")
				recorder := httptest.NewRecorder()
				tokenizerHandler.ServeHTTP(recorder, request)
				var answer struct {
					IDs   []int `json:"ids"`
					Count int   `json:"count"`
				}
				_ = json.Unmarshal(recorder.Body.Bytes(), &answer)
				estimate := tokenizers.Guesstimate(text)
				if recorder.Code != http.StatusOK {
					return okResult("refused with %d: %s", recorder.Code, strings.TrimSpace(recorder.Body.String()))
				}
				if answer.Count == estimate && len(answer.IDs) == 0 {
					return violation("with no tokenizer tree the route answered 200 with the Guesstimate %d and no ids: a wrong count indistinguishable from an exact one", answer.Count)
				}
				return okResult("answered %d ids with count %d", len(answer.IDs), answer.Count)
			},
		},
		{
			id:        "boot.two-concurrent",
			checklist: "boot.concurrent",
			invariant: "two boots of one tree both finish inside a bound and neither corrupts the tree (rule 24/12)",
			run: func() caseResult {
				results := make(chan error, 2)
				for attempt := 0; attempt < 2; attempt++ {
					go func() {
						_, startErr := startup.InitializeDataStartup(dataStartupOptions(concurrentInstall, concurrentData))
						results <- startErr
					}()
				}
				for attempt := 0; attempt < 2; attempt++ {
					select {
					case startErr := <-results:
						if startErr != nil {
							return violation("one of two concurrent boots failed: %v", startErr)
						}
					case <-time.After(90 * time.Second):
						return violation("a concurrent boot did not finish within 90s")
					}
				}
				return okResult("both boots finished")
			},
		},
		{
			id:        "boot.data-startup-lock-held",
			checklist: "boot.data-lock-held",
			invariant: "rule 24: a second process starting while the first holds a data-startup lock must fail with a named error inside a bound, not block forever",
			run: func() caseResult {
				if _, err := startup.InitializeDataStartup(dataStartupOptions(lockInstall, lockData)); err != nil {
					return violation("the warm-up boot failed: %v", err)
				}
				key, err := canonicalLockKey(lockData)
				if err != nil {
					return violation("canonicalise the data root: %v", err)
				}
				lockPath := productLockPath("gotavern-content-seed-locks", key)
				if _, statErr := os.Stat(lockPath); statErr != nil {
					return violation("the product did not create the content lock file this case mirrors (%s), so the case is not faithful: %v", lockPath, statErr)
				}
				held := flock.New(lockPath, flock.SetPermissions(0o600))
				if err := held.Lock(); err != nil {
					return violation("hold %s: %v", lockPath, err)
				}
				blocked := make(chan error, 1)
				go func() {
					_, startErr := startup.InitializeDataStartup(dataStartupOptions(lockInstall, lockData))
					blocked <- startErr
				}()
				// THE BOUND IS THE PRODUCT'S, NOT THIS CASE'S. The contract (ARCHITECTURE 34.2, rule 24) is that a
				// blocked boot gives up with a NAMED error inside the documented boot budget -- lockacquire's default
				// is 30s. An earlier version of this case used a 3s window, which a correctly bounded 30s wait cannot
				// meet, so it reported a violation for contract-compliant behaviour. 45s is that budget plus slack for
				// CI scheduling, and the case still releases nothing before the bound: releasing early would let an
				// unbounded implementation look bounded, which is the whole defect.
				const budgetWithSlack = 45 * time.Second
				started := time.Now()
				var blockingErr error
				select {
				case blockingErr = <-blocked:
				case <-time.After(budgetWithSlack):
					_ = held.Close()
					<-blocked
					return violation("the second boot was still waiting %s after the content lock was taken, longer than the documented boot budget, so the acquisition is not bounded", budgetWithSlack)
				}
				_ = held.Close()
				elapsed := time.Since(started)
				if blockingErr == nil {
					return violation("the second boot reported success after %s while this case held the content lock, so it never contended", elapsed)
				}
				message := strings.ToLower(blockingErr.Error())
				if !strings.Contains(message, "locked by another") && !strings.Contains(message, "busy") {
					return violation("the second boot failed after %s without naming the lock, so a user cannot tell a race from a crash: %v", elapsed, blockingErr)
				}
				return okResult("gave up after %s with a named lock error", elapsed)
			},
		},
		{
			id:        "boot.legacy-migration-cost",
			checklist: "boot.legacy-cost",
			invariant: "rule 24/33: boot reaches its listener inside a bound even in a legacy tree; a silent pinned ten-second warning plus a double copy is indistinguishable from the reported hang",
			run: func() caseResult {
				started := time.Now()
				running, startErr := startProduct(legacyInstall, legacyWork, legacyData, legacyPort, nil)
				elapsed := time.Since(started)
				if startErr != nil {
					return violation("the legacy-tree boot failed after %s: %v", elapsed, startErr)
				}
				_ = running.Close(context.Background())
				if elapsed > 5*time.Second {
					return violation("boot took %s before it could serve a legacy tree; the pinned ten-second warning is spent in silence before any output", elapsed.Round(100*time.Millisecond))
				}
				return okResult("booted in %s", elapsed.Round(10*time.Millisecond))
			},
		},
		{
			id:        "boot.data-root-parent-missing",
			checklist: "data-root.parent-missing",
			invariant: "an absolute --dataRoot whose parents do not exist is created (the pinned MkdirAll) rather than failing later inside the data chain",
			run: func() caseResult {
				running, startErr := startProduct(deepInstall, deepWork, deepDataRoot, deepPort, noLegacyWait)
				if startErr != nil {
					if _, statErr := os.Stat(deepDataRoot); statErr != nil {
						return violation("boot failed and %s was never created: %v", deepDataRoot, startErr)
					}
					return okResult("created %s and failed later with %v", deepDataRoot, startErr)
				}
				_ = running.Close(context.Background())
				if _, statErr := os.Stat(deepDataRoot); statErr != nil {
					return violation("boot succeeded but %s does not exist", deepDataRoot)
				}
				return okResult("created %s", deepDataRoot)
			},
		},
	}
}
