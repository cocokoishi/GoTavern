package server

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/cocokoishi/gotavern/internal/commandline"
)

type serverProtocolsFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]serverProtocolScenario `json:"scenarios"`
}

type serverProtocolScenario struct {
	Options    commandline.ServerOptions `json:"options"`
	Interfaces []serverProtocolInterface `json:"interfaces"`
	Result     serverProtocolResult      `json:"result"`
}

type serverProtocolInterface struct {
	Family  string `json:"family"`
	Address string `json:"address"`
}

type serverProtocolResult struct {
	UseIPv4     *bool    `json:"useIPv4"`
	UseIPv6     *bool    `json:"useIPv6"`
	ExitCode    *int     `json:"exitCode"`
	Stderr      []string `json:"stderr"`
	ListenCalls []struct {
		Host     string `json:"host"`
		Port     int    `json:"port"`
		IPv6Only bool   `json:"ipv6Only"`
	} `json:"listenCalls"`
}

func TestResolveProtocolSelectionMatchesPinnedServerStartup(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-server-protocols.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture serverProtocolsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("server protocol oracle baseline = %+v", fixture.Baseline)
	}

	for name, scenario := range fixture.Scenarios {
		t.Run(name, func(t *testing.T) {
			addresses := make([]net.Addr, 0, len(scenario.Interfaces))
			for _, iface := range scenario.Interfaces {
				ip := net.ParseIP(iface.Address)
				if ip == nil {
					t.Fatalf("invalid fixture IP address %q", iface.Address)
				}
				addresses = append(addresses, &net.IPAddr{IP: ip})
			}

			selection, err := ResolveProtocolSelection(scenario.Options, addresses)
			if scenario.Result.ExitCode != nil {
				if *scenario.Result.ExitCode != 1 {
					t.Fatalf("pinned protocol exit code = %d, want 1", *scenario.Result.ExitCode)
				}
				if err == nil {
					t.Fatalf("pinned startup exited with %q; Go selected %+v", scenario.Result.Stderr, selection)
				}
				if len(scenario.Result.Stderr) != 1 || err.Error() != scenario.Result.Stderr[0] {
					t.Fatalf("protocol error = %q, pinned stderr = %v", err, scenario.Result.Stderr)
				}
				if len(scenario.Result.ListenCalls) != 0 {
					t.Fatalf("pinned startup listened before exit: %+v", scenario.Result.ListenCalls)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveProtocolSelection() error = %v", err)
			}
			if scenario.Result.UseIPv4 == nil || scenario.Result.UseIPv6 == nil {
				t.Fatalf("pinned startup has no protocol result: %+v", scenario.Result)
			}
			want := ProtocolSelection{UseIPv4: *scenario.Result.UseIPv4, UseIPv6: *scenario.Result.UseIPv6}
			if !reflect.DeepEqual(selection, want) {
				t.Fatalf("protocol selection = %+v, pinned ServerStartup = %+v", selection, want)
			}
			wantListeners := 0
			if want.UseIPv6 {
				wantListeners++
			}
			if want.UseIPv4 {
				wantListeners++
			}
			if len(scenario.Result.ListenCalls) != wantListeners {
				t.Fatalf("pinned listener count = %d, selected protocols require %d", len(scenario.Result.ListenCalls), wantListeners)
			}
		})
	}
}
