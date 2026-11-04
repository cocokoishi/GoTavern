package app

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

// SlowStageThreshold used to be the point at which a stage printed even with tracing off. GOAL.md §15.5
// ("by default it is quiet: no internal stage timings unless asked") removes that automatic line: stage
// timings are now an explicit opt-in only (GOTAVERN_STARTUP_TRACE or --verbose). The constant is kept so
// external review references and the qualification scripts keep a name for the threshold they describe.
const SlowStageThreshold = 200 * time.Millisecond

// startupTracer reports named startup stages with their durations.
//
// WHY THIS EXISTS. `cmd/gotavern/main.go` prints nothing between entering main() and "listener ready", and
// docs/startup-state-machine.md records the consequence: a hang anywhere in a seventeen-step chain is
// indistinguishable from a hang anywhere else, which is precisely how the P0-B report presented. The trace is
// written to STDERR so the readiness line on stdout stays the single machine-readable signal a test may poll.
//
// Output policy, deliberately: a stage is printed ONLY when tracing is explicitly requested
// (GOTAVERN_STARTUP_TRACE or cmd/gotavern --verbose). A normal boot prints no stage timings at all, which is
// what "quiet by default" means now; the legacy-wait announcement below remains unconditional because a
// silent ten-second pause is the one thing a user cannot interpret without a line. A stage that never
// finishes is the one signal that cannot be printed afterwards, so the tracer also exposes Close with the
// stage still open.
type startupTracer struct {
	mutex   sync.Mutex
	writer  io.Writer
	enabled bool
	began   time.Time
	last    time.Time
	open    string
	printed bool
}

// newStartupTracer builds a tracer writing to writer, enabling every stage when the environment asks for it.
func newStartupTracer(writer io.Writer) *startupTracer {
	now := time.Now()
	return &startupTracer{
		writer:  writer,
		enabled: startupTraceRequested(os.Getenv("GOTAVERN_STARTUP_TRACE")),
		began:   now,
		last:    now,
	}
}

// startupTraceRequested accepts the same spellings a user is likely to type, and nothing surprising: any of
// "1", "true", "yes", "on" after lower/trim. Anything else is off, because a trace that switches itself on for
// `GOTAVERN_STARTUP_TRACE=0` would be an output change nobody asked for.
func startupTraceRequested(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// begin opens a stage. Stages nest in the sense that only one may be open at a time; beginning a new one implicitly
// closes the previous, which keeps the call sites to one line each.
func (t *startupTracer) begin(stage string) {
	if t == nil {
		return
	}
	t.mutex.Lock()
	defer t.mutex.Unlock()
	if t.open != "" {
		t.finishLocked()
	}
	t.open = stage
}

// end closes the currently open stage and prints it only when tracing is on.
func (t *startupTracer) end() {
	if t == nil {
		return
	}
	t.mutex.Lock()
	defer t.mutex.Unlock()
	t.finishLocked()
}

func (t *startupTracer) finishLocked() {
	if t.open == "" {
		return
	}
	now := time.Now()
	elapsed := now.Sub(t.last)
	t.last = now
	if !t.enabled {
		t.open = ""
		return
	}
	// THE TOKEN IS THE CONTRACT: ARCHITECTURE 34.2 names the stages as startup.begin .. startup.ready, and a
	// harness that greps for that spelling must find it. Prose alone made the drop-in qualification's diagnosis
	// report "no stage trace" while the trace was working -- a false absence, which is the failure mode this
	// project treats as a defect in the instrument rather than in the product.
	_, _ = fmt.Fprintf(t.writer, "gotavern: startup.%s took %s (total %s)\n",
		t.open, elapsed.Round(time.Millisecond), now.Sub(t.began).Round(time.Millisecond))
	t.printed = true
	t.open = ""
}

// waitBeforeLegacyDataMove reports how long a wait is about to take, BEFORE it is spent. The pinned legacy path
// sits in a silent ten-second warning; printing the intention first is what turns that from "hung" into "waiting",
// and it costs one line.
func (t *startupTracer) waitBeforeLegacyDataMove(duration time.Duration) {
	if t == nil {
		return
	}
	t.mutex.Lock()
	defer t.mutex.Unlock()
	_, _ = fmt.Fprintf(t.writer, "gotavern: startup.legacy-wait %s before moving legacy data (pinned behaviour)\n",
		duration.Round(time.Millisecond))
	t.printed = true
}
