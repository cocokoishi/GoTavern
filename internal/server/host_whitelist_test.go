package server

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

type hostWhitelistOracle struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		HostWhitelistEnabled bool     `json:"hostWhitelistEnabled"`
		HostWhitelistScan    bool     `json:"hostWhitelistScan"`
		Hosts                []string `json:"hosts"`
	} `json:"inputs"`
	Observations map[string]struct {
		Host   string `json:"host"`
		Status int    `json:"status"`
	} `json:"observations"`
	ScanWarnings struct {
		FirstRequest    []string `json:"firstRequest"`
		RepeatedRequest []string `json:"repeatedRequest"`
	} `json:"scanWarnings"`
	ScanDisabled struct {
		FirstResponse struct {
			Host   string `json:"host"`
			Status int    `json:"status"`
		} `json:"firstResponse"`
		RepeatedResponse struct {
			Status int `json:"status"`
		} `json:"repeatedResponse"`
		DifferentHostResponse struct {
			Status int `json:"status"`
		} `json:"differentHostResponse"`
		FirstWarnings         []string `json:"firstWarnings"`
		RepeatedWarnings      []string `json:"repeatedWarnings"`
		DifferentHostWarnings []string `json:"differentHostWarnings"`
	} `json:"scanDisabled"`
}

func readHostWhitelistOracle(t *testing.T) hostWhitelistOracle {
	t.Helper()
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-host-whitelist.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture hostWhitelistOracle
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("host-whitelist oracle baseline = %+v", fixture.Baseline)
	}
	return fixture
}

func TestPinnedHostWhitelistPatternMatching(t *testing.T) {
	fixture := readHostWhitelistOracle(t)
	for name, observation := range fixture.Observations {
		t.Run(name, func(t *testing.T) {
			host := observation.Host
			if host == "" {
				t.Fatal("host-whitelist observation has an empty Host header")
			}
			got := isPinnedHostAllowed(host, fixture.Inputs.Hosts)
			want := observation.Status == 200
			if got != want {
				t.Errorf("host %q allowed = %t; pinned Node allowed = %t", host, got, want)
			}
		})
	}
}

func TestPinnedHostWhitelistScanWarningDeduplication(t *testing.T) {
	fixture := readHostWhitelistOracle(t)
	var warnings bytes.Buffer
	options := HTTPHandlerOptions{
		HostWhitelistEnabled:       fixture.Inputs.HostWhitelistEnabled,
		HostWhitelistScan:          fixture.Inputs.HostWhitelistScan,
		HostWhitelistHosts:         fixture.Inputs.Hosts,
		hostWhitelistWarningWriter: &warnings,
	}
	runtime := newHostWhitelistRuntime(options)
	first := httptest.NewRecorder()
	firstRequest := httptest.NewRequest("GET", "/version", nil)
	firstRequest.Host = fixture.Observations["caseMismatch"].Host
	if runtime.allow(first, firstRequest) {
		t.Fatal("enabled host whitelist allowed an untrusted host")
	}
	firstLines := bytesToLines(warnings.Bytes())
	if !equalStringSlices(firstLines, fixture.ScanWarnings.FirstRequest) {
		t.Fatalf("first scan warning lines = %#v; pinned Node has %#v", firstLines, fixture.ScanWarnings.FirstRequest)
	}

	warnings.Reset()
	repeat := httptest.NewRecorder()
	repeatRequest := httptest.NewRequest("GET", "/version", nil)
	repeatRequest.Host = firstRequest.Host
	if runtime.allow(repeat, repeatRequest) {
		t.Fatal("enabled host whitelist allowed a repeated untrusted host")
	}
	repeatedLines := bytesToLines(warnings.Bytes())
	if !equalStringSlices(repeatedLines, fixture.ScanWarnings.RepeatedRequest) {
		t.Fatalf("repeated scan warning lines = %#v; pinned Node has %#v", repeatedLines, fixture.ScanWarnings.RepeatedRequest)
	}
}

func TestPinnedHostWhitelistScanWarnsWithoutEnforcement(t *testing.T) {
	fixture := readHostWhitelistOracle(t)
	var warnings bytes.Buffer
	runtime := newHostWhitelistRuntime(HTTPHandlerOptions{
		HostWhitelistEnabled:       false,
		HostWhitelistScan:          true,
		HostWhitelistHosts:         fixture.Inputs.Hosts,
		hostWhitelistWarningWriter: &warnings,
	})
	for _, scenario := range []struct {
		name         string
		host         string
		wantStatus   int
		wantWarnings []string
	}{
		{"first", fixture.ScanDisabled.FirstResponse.Host, fixture.ScanDisabled.FirstResponse.Status, fixture.ScanDisabled.FirstWarnings},
		{"repeat", fixture.ScanDisabled.FirstResponse.Host, fixture.ScanDisabled.RepeatedResponse.Status, fixture.ScanDisabled.RepeatedWarnings},
		{"different", "second-scan-disabled.example.org", fixture.ScanDisabled.DifferentHostResponse.Status, fixture.ScanDisabled.DifferentHostWarnings},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			request := httptest.NewRequest("GET", "/version", nil)
			request.Host = scenario.host
			if got := runtime.allow(response, request); !got {
				t.Fatal("scan-only mode blocked the request")
			}
			if response.Code != scenario.wantStatus {
				t.Fatalf("scan-only response status = %d; pinned Node has %d", response.Code, scenario.wantStatus)
			}
			if got := bytesToLines(warnings.Bytes()); !equalStringSlices(got, scenario.wantWarnings) {
				t.Fatalf("scan-only warning lines = %#v; pinned Node has %#v", got, scenario.wantWarnings)
			}
			warnings.Reset()
		})
	}
}

func bytesToLines(data []byte) []string {
	lines := bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n"))
	if len(lines) == 1 && len(lines[0]) == 0 {
		return nil
	}
	result := make([]string, len(lines))
	for index, line := range lines {
		result[index] = string(line)
	}
	return result
}

func equalStringSlices(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
