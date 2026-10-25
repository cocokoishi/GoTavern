package app

// P0-B REPRODUCER.
//
// The report: a stock SillyTavern directory starts fine with `node server.js`; the GoTavern release binary
// placed in that same directory hangs in initialisation forever, printing nothing.
//
// Every scenario below drives the REAL Start (not a mock) against a stock-tree-shaped root and gives it a
// hard bound. A scenario that exceeds the bound FAILS with every goroutine stack and a filesystem diff, so
// the failure names the wait instead of hanging the suite.
//
// What each scenario is FOR, so a future reader does not delete one:
//
//	(a) CWD == the server root           the user's own layout: assets and data in one directory
//	(b) foreign CWD, binary in the root  the layout of `cd /srv && /srv/gotavern`: CWD decides config/data
//	(c) config lock held by another      the P0-B hang: unbounded flock.Lock() before any output
//	(d) stale lock FILE, nobody holds it must NOT block -- flock is released on process death
//	(e) legacy config keys               boot must migrate them, not hang or silently skip
//	(f) unknown config keys              boot must preserve them (never delete a user's key)
//	(g) two processes racing             one may lose, but it must lose with a named error, not forever

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/configinit"
	"github.com/gofrs/flock"
)

// scenarioBound is the hard limit for one boot. It is deliberately far above a healthy boot (milliseconds
// for a temp tree) and far below the CI job timeout, so a hang is reported as a hang.
const scenarioBound = 30 * time.Second

// boundedStartErrorWait is the longest a scenario tolerates start-up spending on a lock before giving up.
// The production bound is 10s per lock inside a 30s boot budget; a little slack covers a slow runner.
const boundedStartErrorWait = 12 * time.Second

type startOutcome struct {
	running *RunningServer
	err     error
}

// baseScenarioArgs mirrors what the installation docs tell a user to run, with a free port so two scenarios
// (or two boots in one scenario) never collide.
func baseScenarioArgs(t *testing.T) []string {
	t.Helper()
	return []string{
		"--enableIPv4", "true",
		"--enableIPv6", "false",
		"--listen", "false",
		"--port", strconv.Itoa(availableIPv4Port(t)),
		"--heartbeatInterval", "0",
		"--browserLaunchEnabled", "false",
	}
}

// scenarioOptions mirrors the documented invocation, with the two things a test must not depend on (a fixed
// clock and a real legacy-move sleep) made deterministic. Fields are assigned one per statement rather than
// in one aligned literal so the shape cannot depend on gofmt's column alignment.
func scenarioOptions(t *testing.T, workingDirectory string, installRoot string) StartOptions {
	t.Helper()
	options := StartOptions{Args: baseScenarioArgs(t)}
	options.WorkingDirectory = workingDirectory
	options.InstallRoot = installRoot
	options.Now = time.UnixMilli(1735689600000)
	options.WaitBeforeLegacyDataMove = func(time.Duration) {}
	options.InterfaceAddresses = []net.Addr{}
	return options
}

// startBounded runs Start in its own goroutine and fails the test if it does not return in time, printing
// the goroutine stacks and the filesystem diff. The goroutine is abandoned on timeout on purpose: the point
// of the reproducer is that the call never returns, so waiting for it would hang CI instead of reporting.
func startBounded(t *testing.T, label string, treeRoot string, options StartOptions) (*RunningServer, error) {
	t.Helper()
	before := snapshotTree(treeRoot)
	done := make(chan startOutcome, 1)
	started := time.Now()
	go func() {
		running, err := Start(options)
		done <- startOutcome{running: running, err: err}
	}()
	select {
	case out := <-done:
		t.Logf("%s: Start returned after %s (err=%v)", label, time.Since(started).Round(time.Millisecond), out.err)
		if out.running != nil {
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = out.running.Close(ctx)
			})
		}
		return out.running, out.err
	case <-time.After(scenarioBound):
		buffer := make([]byte, 1<<20)
		stacks := buffer[:runtime.Stack(buffer, true)]
		t.Fatalf(
			"%s: Start did not return within %s -- THIS IS THE P0-B HANG.\ntree changes before the hang:\n%s\ngoroutines:\n%s",
			label, scenarioBound, describeTreeDiff(before, snapshotTree(treeRoot)), stacks,
		)
		return nil, nil
	}
}

// snapshotTree records path -> size+mtime for everything under root, so a hang can say what the boot managed
// to write before it blocked.
func snapshotTree(root string) map[string]string {
	entries := map[string]string{}
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		if info.IsDir() {
			entries[relative] = "dir"
			return nil
		}
		entries[relative] = fmt.Sprintf("%d@%d", info.Size(), info.ModTime().UnixNano())
		return nil
	})
	return entries
}

func describeTreeDiff(before, after map[string]string) string {
	lines := make([]string, 0, len(after))
	for path, state := range after {
		if previous, ok := before[path]; !ok {
			lines = append(lines, "+ "+path+" "+state)
		} else if previous != state {
			lines = append(lines, "~ "+path+" "+previous+" -> "+state)
		}
	}
	for path := range before {
		if _, ok := after[path]; !ok {
			lines = append(lines, "- "+path)
		}
	}
	if len(lines) == 0 {
		return "  (nothing was written)"
	}
	sort.Strings(lines)
	const limit = 40
	if len(lines) > limit {
		lines = append(lines[:limit], fmt.Sprintf("... and %d more", len(lines)-limit))
	}
	return "  " + strings.Join(lines, "\n  ")
}

// (a) The user's own layout: the binary and the tree in the same directory, CWD == that directory.
func TestP0BStockTreeInWorkingDirectoryStarts(t *testing.T) {
	root := t.TempDir()
	if _, err := startBounded(t, "cwd=root", root, scenarioOptions(t, root, root)); err != nil {
		t.Fatalf("a stock tree in the working directory did not start: %v", err)
	}
}

// (b) The binary lives in the server root but the process starts somewhere else. Pinned resolves the config
// and data root against the CWD, so this is a DIFFERENT tree; it must still boot, not hang.
func TestP0BForeignWorkingDirectoryWithBinaryElsewhereStarts(t *testing.T) {
	installRoot := t.TempDir()
	workingDirectory := t.TempDir()
	if _, err := startBounded(t, "cwd=foreign", workingDirectory, scenarioOptions(t, workingDirectory, installRoot)); err != nil {
		t.Fatalf("a foreign working directory with the tree elsewhere did not start: %v", err)
	}
}

// (c) THE P0-B HANG. Another process holds the config lock. Today this blocks forever before the first byte
// of output; the contract is a NAMED error within the bound.
func TestP0BConfigLockHeldByAnotherProcessFailsWithNamedError(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.yaml")
	lockPath, err := configinit.LockPath(configPath)
	if err != nil {
		t.Fatalf("resolve config lock path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		t.Fatalf("create lock directory: %v", err)
	}
	holder := flock.New(lockPath, flock.SetPermissions(0o600))
	held, err := holder.TryLock()
	if err != nil {
		t.Fatalf("hold the config lock: %v", err)
	}
	if !held {
		t.Fatalf("could not hold the config lock %s: another test process is using it", lockPath)
	}
	defer func() {
		if err := holder.Unlock(); err != nil {
			t.Errorf("release the config lock: %v", err)
		}
	}()

	options := scenarioOptions(t, root, root)
	started := time.Now()
	_, startErr := startBounded(t, "config lock held", root, options)
	waited := time.Since(started)

	if startErr == nil {
		t.Fatalf("startup SUCCEEDED while another process held the config lock (%s); it must not share a tree", lockPath)
	}
	if !strings.Contains(startErr.Error(), "another GoTavern process") {
		t.Fatalf("startup failed without naming the lock contention: %v", startErr)
	}
	if !strings.Contains(startErr.Error(), "config") {
		t.Fatalf("the error must name WHICH lock is held: %v", startErr)
	}
	if waited > boundedStartErrorWait {
		t.Fatalf("startup waited %s for the config lock; the bound must fail it within %s", waited, boundedStartErrorWait)
	}
}

// (d) A lock FILE left behind, with nobody holding it. flock is released when a process dies, so the file is
// an ordinary file: this must not block, and it must not be "fixed" by deleting lock files.
func TestP0BStaleConfigLockFileDoesNotBlockBoot(t *testing.T) {
	root := t.TempDir()
	lockPath, err := configinit.LockPath(filepath.Join(root, "config.yaml"))
	if err != nil {
		t.Fatalf("resolve config lock path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		t.Fatalf("create lock directory: %v", err)
	}
	if err := os.WriteFile(lockPath, []byte("stale lock file left by a crashed process\n"), 0o600); err != nil {
		t.Fatalf("write the stale lock file: %v", err)
	}

	options := scenarioOptions(t, root, root)
	started := time.Now()
	if _, err := startBounded(t, "stale lock file", root, options); err != nil {
		t.Fatalf("a stale lock FILE (nobody holding it) blocked the boot: %v", err)
	}
	if waited := time.Since(started); waited > boundedStartErrorWait {
		t.Fatalf("boot took %s with an unheld lock file; it must not wait on it at all", waited)
	}
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatalf("the lock file was deleted, presumably to break a deadlock: %v", err)
	}
}

// (e) Legacy keys must be migrated on boot, and the boot must be bounded while doing it.
func TestP0BLegacyKeysBootBounded(t *testing.T) {
	root := t.TempDir()
	legacy := "disableChatBackup: true\nminLogLevel: 2\nautorun: false\n"
	if err := os.WriteFile(filepath.Join(root, "config.yaml"), []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy config: %v", err)
	}
	if _, err := startBounded(t, "legacy keys", root, scenarioOptions(t, root, root)); err != nil {
		t.Fatalf("a config with legacy keys did not boot: %v", err)
	}
}

// (f) Unknown keys belong to the user and must survive a boot.
func TestP0BUnknownConfigKeysSurviveBoot(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.yaml")
	original := "someFutureSection:\n  deep:\n    keptValue: 41\nenableIPv4: true\n"
	if err := os.WriteFile(configPath, []byte(original), 0o644); err != nil {
		t.Fatalf("write config with unknown keys: %v", err)
	}
	if _, err := startBounded(t, "unknown keys", root, scenarioOptions(t, root, root)); err != nil {
		t.Fatalf("a config with unknown keys did not boot: %v", err)
	}
	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config after boot: %v", err)
	}
	if !strings.Contains(string(after), "someFutureSection") || !strings.Contains(string(after), "keptValue: 41") {
		t.Fatalf("boot DESTROYED an unknown config section.\nafter:\n%s", after)
	}
}

// (h) READ-ONLY BOOT. A config that PARSES is not ours to rewrite just because our defaults exist: the
// missing values must be supplied in memory. Byte-identity is the assertion, not "no error", because today
// `configinit.Initialize` rewrites whenever mergeDefaults reports a change (config.go:123,136) and a stock
// first boot therefore rewrites config.yaml every time (rule 27).
func TestP0BParseableConfigIsNotRewrittenOnBoot(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.yaml")
	// A user's config: valid YAML, valid keys, and deliberately missing hundreds of defaulted ones.
	userConfig := "port: 8123\nenableIPv4: true\nsomeFutureSection:\n  keptValue: 41\n"
	if err := os.WriteFile(configPath, []byte(userConfig), 0o644); err != nil {
		t.Fatalf("write user config: %v", err)
	}
	if _, err := startBounded(t, "read-only boot", root, scenarioOptions(t, root, root)); err != nil {
		t.Fatalf("a parseable user config did not boot: %v", err)
	}
	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config after boot: %v", err)
	}
	if string(after) != userConfig {
		t.Fatalf(
			"boot REWROTE a parseable user config (rule 27: missing values resolve in memory, any write is an explicit logged migration).\nbefore:\n%s\nafter:\n%s",
			userConfig, after,
		)
	}
}

// (g) Two boots of the same tree at once. Exactly one may win, the loser must fail by NAME and quickly, and
// neither may hang. Options are built on the test goroutine because building them calls t.Fatalf on error,
// which is illegal from a goroutine.
func TestP0BTwoConcurrentBootsDoNotHang(t *testing.T) {
	root := t.TempDir()
	options := []StartOptions{scenarioOptions(t, root, root), scenarioOptions(t, root, root)}
	outcomes := make([]startOutcome, len(options))
	var wg sync.WaitGroup
	wg.Add(len(options))
	for index := range options {
		go func(slot int) {
			defer wg.Done()
			running, err := Start(options[slot])
			outcomes[slot] = startOutcome{running: running, err: err}
		}(index)
	}
	finished := make(chan struct{})
	go func() { wg.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(scenarioBound):
		buffer := make([]byte, 1<<20)
		stacks := buffer[:runtime.Stack(buffer, true)]
		t.Fatalf("two concurrent boots on one tree did not finish within %s -- one of them is hanging.\ngoroutines:\n%s", scenarioBound, stacks)
	}
	for _, outcome := range outcomes {
		if outcome.running != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = outcome.running.Close(ctx)
			cancel()
		}
		t.Logf("boot outcome: err=%v", outcome.err)
	}
	succeeded, busy := 0, 0
	var other []error
	for _, outcome := range outcomes {
		switch {
		case outcome.err == nil:
			succeeded++
		case strings.Contains(outcome.err.Error(), "another GoTavern process"):
			busy++
		default:
			other = append(other, outcome.err)
		}
	}
	if succeeded == 0 {
		t.Fatalf("neither concurrent boot succeeded (busy=%d, other=%v); one must win", busy, other)
	}
	if len(other) > 0 {
		t.Fatalf("a concurrent boot failed for a reason that does not name lock contention: %v", other)
	}
}
