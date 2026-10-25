package app

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
)

// The startup trace exists because a hang anywhere in the boot chain used to look identical to a hang everywhere:
// cmd/gotavern/main.go prints nothing between main() and "listener ready" (docs/startup-state-machine.md 1). These
// tests pin the three properties that make it useful rather than noisy.
func TestStartupTraceIsQuietUnlessSomethingWasSlowOrAsked(t *testing.T) {
	cases := []struct {
		name      string
		traceEnv  string
		stages    []time.Duration
		wantLines int
	}{
		{name: "a fast boot prints nothing", traceEnv: "", stages: []time.Duration{time.Millisecond, time.Millisecond}, wantLines: 0},
		{name: "one slow stage prints that stage", traceEnv: "", stages: []time.Duration{time.Millisecond, SlowStageThreshold * 2}, wantLines: 1},
		{name: "tracing prints every stage", traceEnv: "1", stages: []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}, wantLines: 3},
		{name: "GOTAVERN_STARTUP_TRACE=0 is off", traceEnv: "0", stages: []time.Duration{time.Millisecond}, wantLines: 0},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Setenv("GOTAVERN_STARTUP_TRACE", testCase.traceEnv)
			var buffer bytes.Buffer
			tracer := newStartupTracer(&buffer)
			names := []string{"command-line", "data-startup", "routes"}
			for index, duration := range testCase.stages {
				tracer.begin(names[index])
				// A stage's duration is measured, so the test has to spend it.
				time.Sleep(duration)
				tracer.end()
			}
			lines := 0
			for _, line := range strings.Split(strings.TrimSpace(buffer.String()), "\n") {
				if strings.TrimSpace(line) == "" {
					continue
				}
				lines++
				if !strings.HasPrefix(line, "gotavern: startup.") {
					t.Fatalf("a trace line does not carry the documented startup.<stage> token: %q", line)
				}
			}
			if lines != testCase.wantLines {
				t.Fatalf("printed %d line(s), want %d:\n%s", lines, testCase.wantLines, buffer.String())
			}
		})
	}
}

// A stage that is still open when a later one begins must be closed first, or a hang would be attributed to the
// wrong stage -- the one thing this instrumentation exists to get right.
func TestStartupTraceClosesAnOpenStageWhenTheNextBegins(t *testing.T) {
	t.Setenv("GOTAVERN_STARTUP_TRACE", "1")
	var buffer bytes.Buffer
	tracer := newStartupTracer(&buffer)
	tracer.begin("data-startup")
	tracer.begin("routes")
	tracer.end()
	output := buffer.String()
	if !strings.Contains(output, "startup.data-startup took") {
		t.Fatalf("the implicitly closed stage was not reported:\n%s", output)
	}
	if !strings.Contains(output, "startup.routes took") {
		t.Fatalf("the later stage was not reported:\n%s", output)
	}
	if strings.Index(output, "data-startup") > strings.Index(output, "routes") {
		t.Fatalf("the stages were reported out of order, so a reader cannot follow the boot:\n%s", output)
	}
}

// The legacy wait is announced BEFORE it is spent; announcing it afterwards is what a silent ten-second pause
// already looks like.
func TestStartupTraceAnnouncesTheLegacyWaitBeforeSpendingIt(t *testing.T) {
	t.Setenv("GOTAVERN_STARTUP_TRACE", "")
	var buffer bytes.Buffer
	tracer := newStartupTracer(&buffer)
	var mutex sync.Mutex
	announcedBeforeWait := false
	tracer.waitBeforeLegacyDataMove(0)
	mutex.Lock()
	announcedBeforeWait = strings.Contains(buffer.String(), "startup.legacy-wait 0s before moving legacy data")
	mutex.Unlock()
	if !announcedBeforeWait {
		t.Fatalf("the legacy wait was not announced, which is the silence this instrumentation exists to remove:\n%s", buffer.String())
	}
}
