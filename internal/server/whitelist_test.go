package server

import (
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

func TestWhitelistPatternMatchingMatchesPinnedNodeLibrary(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-fresh-start.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Security struct {
			WhitelistPatternMatches []struct {
				Pattern string `json:"pattern"`
				IP      string `json:"ip"`
				Matches bool   `json:"matches"`
			} `json:"whitelistPatternMatches"`
		} `json:"security"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Security.WhitelistPatternMatches) == 0 {
		t.Fatal("pinned Node oracle has no whitelist pattern cases")
	}
	for _, scenario := range fixture.Security.WhitelistPatternMatches {
		t.Run(scenario.Pattern+"-"+scenario.IP, func(t *testing.T) {
			matcher, ok := parseIPMatcher(scenario.Pattern)
			if !ok {
				t.Fatalf("GoTavern did not parse pinned whitelist pattern %q", scenario.Pattern)
			}
			address, err := netip.ParseAddr(scenario.IP)
			if err != nil {
				t.Fatalf("parse oracle IP %q: %v", scenario.IP, err)
			}
			if got := matcher.matches(address); got != scenario.Matches {
				t.Fatalf("whitelist %q matching %q = %t; pinned Node has %t", scenario.Pattern, scenario.IP, got, scenario.Matches)
			}
		})
	}
}
