package main

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/app"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// TestListenHintBlockNamesTheAccessLog covers the other half of G-02: pinned
// prints a two-line hint naming DATA_ROOT/access.log whenever it listens
// (src/server-main.js:439-443), which is the operator's only pointer to the
// per-connection log.
func TestListenHintBlockNamesTheAccessLog(t *testing.T) {
	dataRoot := filepath.Join(t.TempDir(), "data")

	var silent bytes.Buffer
	printListenHint(&silent, false, dataRoot)
	if silent.Len() != 0 {
		t.Errorf("stdout = %q, want nothing when `listen` is false", silent.String())
	}

	var stdout bytes.Buffer
	printListenHint(&stdout, true, dataRoot)
	got := stdout.String()
	if !strings.HasPrefix(got, "\n") {
		t.Errorf("stdout = %q, want pinned's blank line first", got)
	}
	if !strings.Contains(got, `To limit connections to internal localhost only ([::1] or 127.0.0.1), change the setting in config.yaml to "listen: false".`) {
		t.Errorf("stdout = %q, want pinned's localhost hint verbatim", got)
	}
	if !strings.Contains(got, `Check the "access.log" file in the data directory to inspect incoming connections: `) {
		t.Errorf("stdout = %q, want pinned's access.log hint verbatim", got)
	}
	if !strings.HasSuffix(got, startup.AccessLogPath(dataRoot)+"\n") {
		t.Errorf("stdout = %q, want it to end with the access-log path", got)
	}
}

// TestServingInListenModeWritesTheAccessLog is the end-to-end wiring test: a real
// server booted through app.Start in listen mode, a real HTTP request, and the
// pinned DATA_ROOT/access.log on disk. It is what proves the capability REACHES
// the behaviour rather than merely parsing a config key.
func TestServingInListenModeWritesTheAccessLog(t *testing.T) {
	installRoot := t.TempDir()
	// `listen: true` requires one of the pinned security gates (whitelist, basic auth or user
	// accounts), so the whitelist is enabled with the loopback address the test connects from. The
	// access logger sits AFTER that middleware, which is exactly why the request must pass it.
	config := strings.Join([]string{
		"dataRoot: ./data",
		"listen: true",
		"listenAddress:",
		"  ipv4: 127.0.0.1",
		"  ipv6: '[::]'",
		"protocol:",
		"  ipv4: true",
		"  ipv6: false",
		"port: 0",
		"whitelistMode: true",
		"whitelist:",
		"  - 127.0.0.1",
		"logging:",
		"  enableAccessLog: true",
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	running, err := app.Start(app.StartOptions{
		Args: []string{
			"--enableIPv4", "true", "--enableIPv6", "false", "--listen", "true",
			"--listenAddressIPv4", "127.0.0.1",
			"--port", "0", "--heartbeatInterval", "0", "--browserLaunchEnabled", "false",
		},
		WorkingDirectory:         installRoot,
		InstallRoot:              installRoot,
		WaitBeforeLegacyDataMove: func(time.Duration) {},
		InterfaceAddresses:       []net.Addr{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = running.Close(ctx)
	})
	if !running.StartedIPv4 || len(running.Listeners()) == 0 {
		t.Fatalf("server did not start an IPv4 listener: %+v", running.ListenerFailures)
	}

	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 10 * time.Second}
	response, err := client.Get("http://" + running.Listeners()[0].Addr().String() + "/version")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET /version = %d, want 200", response.StatusCode)
	}

	logPath := startup.AccessLogPath(running.CommandLine.Paths.RuntimeDataRoot)
	body, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("the pinned access log was not written at %s: %v", logPath, err)
	}
	lines := strings.Split(strings.TrimSuffix(string(body), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("access log = %q, want exactly one line for one client", string(body))
	}
	fields := strings.Split(lines[0], " ")
	if len(fields) != 3 {
		t.Fatalf("access log line = %q, want `<iso> <ip> <user-agent>`", lines[0])
	}
	if fields[1] != "127.0.0.1" {
		t.Errorf("logged address = %q, want 127.0.0.1", fields[1])
	}
	if fields[2] != "Go-http-client/1.1" {
		t.Errorf("logged user agent = %q, want the client's own header", fields[2])
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", fields[0]); err != nil {
		t.Errorf("logged timestamp = %q, want the pinned toISOString shape: %v", fields[0], err)
	}
}
