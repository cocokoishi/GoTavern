package main

// The G-06/G-07 honesty channel, at the level the operator sees it.
//
// internal/commandline resolves the warnings and internal/commandline's own tests prove the resolver;
// this file proves the OTHER end: that a config.yaml on disk produces the field, and that the field
// reaches stderr. A warning nobody prints is the same silent acceptance it was written to remove, so
// the assertion here is on the printed bytes, not on the message string.

import (
	"bytes"
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/app"
	"github.com/cocokoishi/gotavern/internal/commandline"
)

// TestUnimplementedConfigWarningsGoToTheWarningStream drives the printer directly: one line per
// warning, on the stream main.go already uses for startup warnings, and nothing at all when there is
// nothing to say.
func TestUnimplementedConfigWarningsGoToTheWarningStream(t *testing.T) {
	var silent bytes.Buffer
	printUnimplementedConfigWarnings(&silent, nil)
	if silent.Len() != 0 {
		t.Fatalf("stderr = %q, want nothing when no key is set", silent.String())
	}

	warnings := []commandline.UnimplementedConfigWarning{
		{Key: "sso.autheliaAuth", Message: "Warning: sso.autheliaAuth is true, but ..."},
		{Key: "privateAddressWhitelist.enabled", Message: "Warning: privateAddressWhitelist.enabled is true, but ..."},
	}
	var stderr bytes.Buffer
	printUnimplementedConfigWarnings(&stderr, warnings)
	lines := strings.Split(strings.TrimSuffix(stderr.String(), "\n"), "\n")
	if len(lines) != len(warnings) {
		t.Fatalf("stderr = %q, want %d lines", stderr.String(), len(warnings))
	}
	for index, warning := range warnings {
		if lines[index] != warning.Message {
			t.Errorf("line %d = %q, want %q", index, lines[index], warning.Message)
		}
	}
}

// TestAnEnabledUnimplementedKeyIsNamedOnStartup is the end-to-end row: a real config.yaml, a real boot
// through app.Start, and the exact bytes an operator would read. It covers both findings the warning
// channel exists for — an SSO method the operator switched on and an SSRF filter the operator switched
// on — and it asserts the key NAME is in the output, because a warning a reader cannot act on is not a
// warning.
func TestAnEnabledUnimplementedKeyIsNamedOnStartup(t *testing.T) {
	installRoot := t.TempDir()
	config := strings.Join([]string{
		"dataRoot: ./data",
		"listen: false",
		"port: 0",
		"browserLaunch:",
		"  enabled: false",
		"sso:",
		"  autheliaAuth: true",
		"  authentikAuth: false",
		"privateAddressWhitelist:",
		"  enabled: true",
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	running, err := app.Start(app.StartOptions{
		Args: []string{
			"--enableIPv4", "true", "--enableIPv6", "false", "--listen", "false",
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

	var stderr bytes.Buffer
	printUnimplementedConfigWarnings(&stderr, running.CommandLine.UnimplementedConfigWarnings)
	output := stderr.String()

	for _, key := range []string{"sso.autheliaAuth"} {
		if !strings.Contains(output, key) {
			t.Errorf("startup output %q does not name %q; an operator who set that key must be told it is ignored", output, key)
		}
	}
	// `privateAddressWhitelist.enabled: true` is in this config and must NOT produce a "not implemented"
	// warning any more: the filter is implemented (internal/outbound/privatefilter.go) and the warning's
	// text would be false. The retirement is asserted here, at the level the operator reads, and the
	// feature itself is proven in internal/outbound and internal/app.
	if strings.Contains(output, "privateAddressWhitelist") {
		t.Errorf("startup output %q still claims privateAddressWhitelist is unimplemented, which is no longer true", output)
	}
	if strings.Contains(output, "sso.authentikAuth") {
		t.Errorf("startup output %q warns about sso.authentikAuth, which is false in this config", output)
	}
	// The remaining warning must not read as a working feature.
	for _, phrase := range []string{"NOT implement", "no effect"} {
		if !strings.Contains(output, phrase) {
			t.Errorf("startup output %q does not contain %q, so it could be read as a claim that the setting works", output, phrase)
		}
	}
}

// TestAStockConfigIsSilentOnStartup is the negative control at the boot level: the fresh-install config
// must produce no warning at all. A channel that speaks on every boot is a channel nobody reads.
func TestAStockConfigIsSilentOnStartup(t *testing.T) {
	stock := filepath.Join("..", "..", "upstream", "default", "config.yaml")
	body, err := os.ReadFile(stock)
	if err != nil {
		t.Skipf("the pinned default config is not present in this checkout: %v", err)
	}
	installRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	running, err := app.Start(app.StartOptions{
		Args: []string{
			"--enableIPv4", "true", "--enableIPv6", "false", "--listen", "false",
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
	var stderr bytes.Buffer
	printUnimplementedConfigWarnings(&stderr, running.CommandLine.UnimplementedConfigWarnings)
	if stderr.Len() != 0 {
		t.Fatalf("a stock config produced startup warnings: %q", stderr.String())
	}
}
