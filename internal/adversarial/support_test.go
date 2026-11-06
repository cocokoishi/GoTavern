package adversarial

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/app"
)

func writeText(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// freePort is the port a case hands the product's --port flag.
//
// BEFORE THIS CHANGE this RESERVED an ephemeral port and closed it again. That is
// a two-step operation over shared machine state, and `go test ./...` runs
// package test binaries in PARALLEL: another package's binary can bind the port
// in the window between this close and the boot's bind. It happened: GoTavern
// Lane CI run 42162940621 (docs-only commit a964c31) reported
//
//	NEW VIOLATION boot.foreign-cwd-relative-data-root: the failure does not
//	name the data root: Error: Startup aborted because IPv4 is the only
//	enabled protocol and its listen port is already in use
//
// and the same tree passed Lane CI one commit later. The boot had died on a
// PORT the harness had made available, and the case blamed the product for not
// reaching the subject: AGENTS verification rule 10 exactly ("a driver that
// reports the absence of an outcome while reporting no error is usually driving
// the subject in a way a user cannot").
//
// THE FIX IS STRUCTURAL. Port 0 asks the KERNEL for an ephemeral port at BIND
// time, so there is no interval between reservation and use for anyone to take
// it: the shared mutable resource is removed rather than managed (AGENTS
// verification rule 7, "prefer the design that REMOVES a hazard"). Node's own
// server.listen(0) means the same thing, and the product reports the bound
// address through RunningServer.Listeners(); no case in this package needs a
// known port number.
//
// IT IS A VARIABLE so the regression test can force the old precondition with a
// REAL held socket (foreign_cwd_data_root_test.go). Only a test assigns it.
var freePort = func(t *testing.T) int {
	t.Helper()
	return 0
}

// canonicalLockKey mirrors the canonicalisation the product applies before it
// hashes a path for a lock file. It is only used together with a faithfulness
// assertion (the product must have created exactly this file), so a drift in
// the mirror can never make a case pass by not contending.
func canonicalLockKey(value string) (string, error) {
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		return resolved, nil
	}
	if parent, err := filepath.EvalSymlinks(filepath.Dir(absolute)); err == nil {
		return filepath.Join(parent, filepath.Base(absolute)), nil
	}
	return filepath.Clean(absolute), nil
}

// productLockPath mirrors internal/configinit/config.go:157-167,
// internal/startup/storage.go:428-438 and internal/startup/content.go:371-381.
func productLockPath(folder, key string) string {
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	digest := sha256.Sum256([]byte(key))
	return filepath.Join(os.TempDir(), folder, hex.EncodeToString(digest[:])+".lock")
}

// startProduct runs the real boot. Every argument is explicit so a case can
// never depend on the test process's own working directory or $HOME.
func startProduct(installRoot, workDir, dataRoot string, port int, waitBeforeMove func(time.Duration), extra ...string) (*app.RunningServer, error) {
	args := []string{"--dataRoot", dataRoot}
	args = append(args, extra...)
	return startProductArgs(installRoot, workDir, port, waitBeforeMove, args...)
}

// startProductArgs is startProduct without a forced --dataRoot, so a case can
// measure what a config file's own relative dataRoot does.
func startProductArgs(installRoot, workDir string, port int, waitBeforeMove func(time.Duration), args ...string) (*app.RunningServer, error) {
	all := append([]string{"--port", strconv.Itoa(port)}, args...)
	return app.Start(app.StartOptions{
		Args:                     all,
		WorkingDirectory:         workDir,
		InstallRoot:              installRoot,
		WaitBeforeLegacyDataMove: waitBeforeMove,
	})
}

// startProductGlobal boots in global mode, which is the only mode that reads
// $HOME for the data root.
func startProductGlobal(installRoot, workDir string, port int) (*app.RunningServer, error) {
	return app.Start(app.StartOptions{
		Args:                     []string{"--port", strconv.Itoa(port)},
		WorkingDirectory:         workDir,
		InstallRoot:              installRoot,
		ForceGlobalMode:          boolPointer(true),
		WaitBeforeLegacyDataMove: noLegacyWait,
	})
}

func noLegacyWait(time.Duration) {}

func boolPointer(value bool) *bool { return &value }

// treeDigest hashes every regular file under root (path, mode, bytes), so a boot
// that mutates the user's tree cannot pass an equality check.
func treeDigest(root string) (string, error) {
	digest := sha256.New()
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if info.IsDir() {
			_, _ = digest.Write([]byte("dir " + relative + "\n"))
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, _ = digest.Write([]byte("file " + relative + " " + info.Mode().String() + "\n"))
		_, _ = digest.Write(body)
		return nil
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// listenerPreconditionFailure reports whether a boot error is the product's
// LISTENER failure rather than a verdict about the invariant a case measures.
//
// Why this exists: GoTavern Lane CI 42162940621 classified
//
//	Error: Startup aborted because IPv4 is the only enabled protocol and its
//	listen port is already in use
//
// as a NEW VIOLATION of boot.foreign-cwd-relative-data-root. That error says the
// boot never reached the listener, which is a machine precondition the harness
// owns (it used to reserve+close a port at suite start while `go test ./...` runs
// package binaries in parallel), not something the data-root invariant has an
// opinion about. AGENTS verification rule 10 is the rule: a driver that never
// reached the subject may not blame the subject.
//
// THE PATTERNS ARE THE PRODUCT'S OWN LISTENER WORDS, taken from
// internal/app/server.go listenerStartupError plus the bind error it wraps, so a
// failure that is not a listener failure can never match this by accident.
func listenerPreconditionFailure(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	for _, needle := range []string{
		"address already in use",
		"listen port is already in use",
		"failed to start server on ",
		"failed to start server because ",
	} {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}
