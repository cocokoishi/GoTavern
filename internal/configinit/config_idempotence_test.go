package configinit

// BOOT MUST NOT REWRITE A CONFIG THAT ALREADY CONTAINS EVERY PINNED DEFAULT.
//
// WHY THIS GATE EXISTS. AGENTS.md 26/27 say startup supplies missing values IN MEMORY and reports them,
// and any write is an explicit, logged, backed-up migration with an idempotence test. There was no
// idempotence test: the existing suites prove the CREATE path byte-exactly and the MIGRATE path against
// a recorded oracle, but nothing pinned the property the two share -- that a config already carrying
// every key the pinned fresh-install document carries is left BYTE-IDENTICAL.
//
// It is not a theoretical property. Both browser legs of the Q21 hand-back are given their config by
// tests/browser/seed-leg-config.mjs, which writes `upstream/default/config.yaml` verbatim, and the
// GoTavern half then boots the product over its own data root (`--configPath <dataRoot>/config.yaml`).
// If `Initialize` treats that document as needing a rewrite, the product modifies the file the witness
// recorded the digest of BEFORE the hand-back, and a review of that difference has to decide, for every
// byte, whether the product was repairing the tree or damaging it. A rewrite also breaks the stronger
// claim `noDataLossOnHandBack` rests on: that what the product wrote is what the next runtime reads.
//
// WHAT THIS ASSERTS, and nothing more:
//   1. a config that is exactly the pinned fresh-install document is not written at all (mtime and bytes
//      unchanged, Result reports neither Created nor Updated);
//   2. the same holds when the document has been re-serialised (so the property is about CONTENT, not
//      about a lucky byte-identity with the embedded asset), which is the shape a user's real config
//      has after any editor pass;
//   3. a second Initialize over the same path is a no-op, so the operation is idempotent by RUNNING it,
//      not by reading the first result.
//
// WHAT IT DOES NOT ASSERT: any behaviour of the HTTP server, or that the values reach the runtime. That
// is a separate observation and a green here must not be quoted as one.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/lockacquire"
	"github.com/cocokoishi/gotavern/upstream"
	"gopkg.in/yaml.v3"
)

// pinnedFreshConfig returns the exact embedded pinned fresh-install document.
func pinnedFreshConfig(t *testing.T) []byte {
	t.Helper()
	body, err := upstream.Assets.ReadFile("generated/default-config.yaml")
	if err != nil {
		t.Fatalf("read pinned fresh config: %v", err)
	}
	if len(body) == 0 {
		t.Fatal("the embedded pinned fresh config is empty")
	}
	return body
}

// assertUntouched fails when the file's bytes or modification time moved.
//
// BOTH are checked because a writer that writes the same bytes back is still a write: it changes mtime,
// it races with a concurrent reader, and on a read-only tree it fails where the correct implementation
// does nothing. Checking bytes alone would pass for a no-op write.
func assertUntouched(t *testing.T, path string, before []byte, beforeMtime time.Time) {
	t.Helper()
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s after Initialize: %v", path, err)
	}
	if string(after) != string(before) {
		index := 0
		for index < len(after) && index < len(before) && after[index] == before[index] {
			index++
		}
		start := index - 60
		if start < 0 {
			start = 0
		}
		end := index + 60
		if end > len(after) {
			end = len(after)
		}
		t.Fatalf("config bytes changed at byte %d (len %d -> %d): got %q", index, len(before), len(after), after[start:end])
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s after Initialize: %v", path, err)
	}
	if !info.ModTime().Equal(beforeMtime) {
		t.Fatalf("config was rewritten with identical bytes: mtime %v -> %v", beforeMtime, info.ModTime())
	}
}

// TestCompletePinnedConfigIsNotRewrittenAtBoot is the invariant.
func TestCompletePinnedConfigIsNotRewrittenAtBoot(t *testing.T) {
	for _, scenario := range []struct {
		name string
		body func(t *testing.T) []byte
	}{
		{
			// The browser legs' own input: the pinned fresh-install document, byte for byte.
			name: "verbatim pinned fresh-install config",
			body: func(t *testing.T) []byte { return pinnedFreshConfig(t) },
		},
		{
			// A user's config after an editor has been at it: same mapping, different serialisation.
			// The property must be about keys and values, not about the embedded asset's exact bytes.
			name: "re-serialised copy of the same mapping",
			body: func(t *testing.T) []byte {
				var document any
				if err := yaml.Unmarshal(pinnedFreshConfig(t), &document); err != nil {
					t.Fatalf("parse pinned fresh config: %v", err)
				}
				encoded, err := yaml.Marshal(document)
				if err != nil {
					t.Fatalf("re-serialise pinned fresh config: %v", err)
				}
				return encoded
			},
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "config.yaml")
			body := scenario.body(t)
			if err := os.WriteFile(path, body, 0o644); err != nil {
				t.Fatalf("write %s: %v", path, err)
			}
			// A stable, distinguishable mtime: a rewrite that preserves the clock to the second would
			// otherwise hide inside the filesystem's granularity.
			stamp := time.Unix(1700000000, 0)
			if err := os.Chtimes(path, stamp, stamp); err != nil {
				t.Fatalf("chtimes %s: %v", path, err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read %s: %v", path, err)
			}

			result, err := Initialize(path)
			if err != nil {
				t.Fatalf("Initialize: %v", err)
			}
			if result.Created {
				t.Fatal("Initialize reported Created for a config that already existed")
			}
			if result.Updated {
				t.Fatal("Initialize reported Updated for a config that already carries every pinned default")
			}
			assertUntouched(t, path, before, stamp)

			// IDEMPOTENT BY RUNNING IT AGAIN, not by reading the first result: the second call starts
			// from whatever the first one left on disk, which is the state a restart actually sees.
			second, err := Initialize(path)
			if err != nil {
				t.Fatalf("second Initialize: %v", err)
			}
			if second.Created || second.Updated {
				t.Fatalf("second Initialize was not a no-op: %+v", second)
			}
			assertUntouched(t, path, before, stamp)
		})
	}
}

// TestInitializeRefusesARunningInstanceAndLeavesTheConfigAlone is the "launched twice" hazard.
//
// Q21 hands one data root from GoTavern to pinned Node and back, and the failure that reads as user data
// loss is the one where a second process writes while the first still holds the tree. The product answers
// that with a BOUNDED acquisition that reports a named busy error (AGENTS 24), never a silent wait and
// never a write. That bound, and the refusal itself, are asserted here because a boot that waits forever
// inside a user's directory is P0-B and must not come back through a config path.
//
// The lock is taken through the same helper the product uses, so the test cannot pass by holding a
// different file than the product checks (the lock path is DERIVED from the config path, which is exactly
// the kind of rule a test can accidentally restate and then not test).
func TestInitializeRefusesARunningInstanceAndLeavesTheConfigAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, pinnedFreshConfig(t), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}

	held, err := acquireLock(path)
	if err != nil {
		t.Fatalf("the product's own lock could not be taken for the test: %v", err)
	}

	// A SHORT BOOT BUDGET, so the assertion is about the refusal and not about how long this host takes.
	// BeginBoot is the product's own mechanism; the alternative (sleeping until DefaultPerLock expires)
	// would make the test slower than the property it checks.
	//
	// TWO HUNDRED MILLISECONDS, and the margin is deliberate: a single uncontended acquisition is a
	// TryLock and returns immediately, so a correct implementation fails here in one retry interval, while
	// an unbounded wait is caught by the upper bound below. The budget must not be zero either -- Bound()
	// answers 0 for an already-expired budget, which is a DIFFERENT branch (an immediate busy error without
	// waiting) and would leave the waiting path untested.
	end := lockacquire.BeginBoot(200 * time.Millisecond)
	started := time.Now()
	_, initErr := Initialize(path)
	elapsed := time.Since(started)
	end()
	_ = held.Close()

	if initErr == nil {
		t.Fatal("Initialize succeeded while another instance held the config lock")
	}
	if !lockacquire.IsBusy(initErr) {
		t.Fatalf("Initialize failed with a non-busy error, so the caller cannot tell a busy tree from a broken one: %v", initErr)
	}
	if !strings.HasPrefix(initErr.Error(), "lock config ") || !strings.Contains(initErr.Error(), "lock file") {
		t.Fatalf("the busy error does not name the config, the lock file and the wait: %v", initErr)
	}
	// THE BOUND IS THE PROPERTY. DefaultPerLock is ten seconds; a refusal that took longer than that
	// means the budget was not applied, which is the P0-B shape with a different lock.
	if elapsed > lockacquire.DefaultPerLock {
		t.Fatalf("the bounded acquisition took %v, which is longer than the per-lock bound %v", elapsed, lockacquire.DefaultPerLock)
	}
	if after, err := os.ReadFile(path); err != nil {
		t.Fatalf("read %s afterwards: %v", path, err)
	} else if string(after) != string(before) {
		t.Fatal("the refused boot modified the config it could not lock")
	}
	if after, err := os.Stat(path); err != nil {
		t.Fatalf("stat %s afterwards: %v", path, err)
	} else if !after.ModTime().Equal(info.ModTime()) {
		t.Fatalf("the refused boot rewrote the config: mtime %v -> %v", info.ModTime(), after.ModTime())
	}
}
