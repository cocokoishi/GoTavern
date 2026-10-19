package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

type pinnedFreshHTTPFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	HTTP struct {
		Responses map[string]struct {
			Headers     map[string]string `json:"headers"`
			Status      int               `json:"status"`
			ContentType string            `json:"contentType"`
			Bytes       int               `json:"bytes"`
			SHA256      string            `json:"sha256"`
			Body        json.RawMessage   `json:"body"`
		} `json:"responses"`
	} `json:"http"`
}

type hostWhitelistHTTPFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		HostWhitelistEnabled bool     `json:"hostWhitelistEnabled"`
		HostWhitelistScan    bool     `json:"hostWhitelistScan"`
		Hosts                []string `json:"hosts"`
		CustomErrorPage      string   `json:"customErrorPageContent"`
	} `json:"inputs"`
	Observations map[string]struct {
		Host        string            `json:"host"`
		Headers     map[string]string `json:"headers"`
		Status      int               `json:"status"`
		ContentType string            `json:"contentType"`
		Bytes       int               `json:"bytes"`
		SHA256      string            `json:"sha256"`
		Body        string            `json:"body"`
	} `json:"observations"`
}

type heartbeatFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		IntervalSeconds float64 `json:"heartbeatIntervalSeconds"`
	} `json:"inputs"`
	Observations struct {
		Immediate struct {
			FilePresent bool     `json:"filePresent"`
			Keys        []string `json:"keys"`
			Timestamp   string   `json:"timestampType"`
		} `json:"immediate"`
		Periodic struct {
			TimestampChanged bool     `json:"timestampChanged"`
			Keys             []string `json:"keys"`
		} `json:"periodic"`
		AfterShutdown struct {
			FilePresent             bool `json:"filePresent"`
			TimestampUnchangedAfter bool `json:"timestampUnchangedAfterExit"`
		} `json:"afterShutdown"`
	} `json:"observations"`
}

func TestStartFreshServerMatchesPinnedNodeHTTPResponses(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-fresh-start.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture pinnedFreshHTTPFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("fresh-start oracle baseline = %+v", fixture.Baseline)
	}

	installRoot := t.TempDir()
	port := availableIPv4Port(t)
	running, err := Start(StartOptions{
		Args: []string{
			"--enableIPv4", "true", "--enableIPv6", "false", "--listen", "false",
			"--port", strconv.Itoa(port), "--heartbeatInterval", "0", "--browserLaunchEnabled", "false",
		},
		WorkingDirectory:         installRoot,
		InstallRoot:              installRoot,
		Now:                      time.UnixMilli(1735689600000),
		WaitBeforeLegacyDataMove: func(time.Duration) {},
		InterfaceAddresses:       []net.Addr{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := running.Close(ctx); err != nil {
			t.Errorf("close GoTavern server: %v", err)
		}
	})
	if !running.StartedIPv4 || running.StartedIPv6 || len(running.ListenerFailures) != 0 {
		t.Fatalf("listener result = IPv4 %t, IPv6 %t, failures %+v", running.StartedIPv4, running.StartedIPv6, running.ListenerFailures)
	}
	if !running.DataStartup.CookieSecretSource.Generated {
		t.Fatalf("fresh startup cookie-secret source = %+v; want generated", running.DataStartup.CookieSecretSource)
	}
	if _, err := os.Stat(filepath.Join(installRoot, "data", "cookie-secret.txt")); err != nil {
		t.Fatalf("fresh startup did not create the cookie secret: %v", err)
	}

	address := running.Listeners()[0].Addr().String()
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 20 * time.Second}
	for _, route := range []string{"/version", "/", "/lib.js", "/__gotavern_missing_route__"} {
		t.Run(route, func(t *testing.T) {
			response, err := client.Get("http://" + address + route)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			expected := fixture.HTTP.Responses[route]
			if response.StatusCode != expected.Status {
				t.Fatalf("status = %d; pinned Node has %d", response.StatusCode, expected.Status)
			}
			if contentType := response.Header.Get("Content-Type"); contentType != expected.ContentType {
				t.Fatalf("Content-Type = %q; pinned Node has %q", contentType, expected.ContentType)
			}
			if route == "/version" {
				var got, want map[string]any
				if err := json.Unmarshal(body, &got); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(expected.Body, &want); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("/version body = %#v; pinned Node has %#v", got, want)
				}
			} else {
				if len(body) != expected.Bytes {
					t.Fatalf("response size = %d; pinned Node has %d", len(body), expected.Bytes)
				}
				digest := sha256.Sum256(body)
				if got := hex.EncodeToString(digest[:]); got != expected.SHA256 {
					t.Fatalf("response SHA-256 = %s; pinned Node has %s", got, expected.SHA256)
				}
			}
		})
	}
	t.Run("forwarded client outside the whitelist", func(t *testing.T) {
		request, err := http.NewRequest(http.MethodGet, "http://"+address+"/version", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("X-Real-IP", "198.51.100.42")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		expected := fixture.HTTP.Responses["GET /version (X-Real-IP: 198.51.100.42)"]
		if response.StatusCode != expected.Status || response.Header.Get("Content-Type") != expected.ContentType {
			t.Fatalf("blocked response = %d %q; pinned Node has %d %q", response.StatusCode, response.Header.Get("Content-Type"), expected.Status, expected.ContentType)
		}
		if len(body) != expected.Bytes {
			t.Fatalf("blocked response size = %d; pinned Node has %d", len(body), expected.Bytes)
		}
		digest := sha256.Sum256(body)
		if got := hex.EncodeToString(digest[:]); got != expected.SHA256 {
			t.Fatalf("blocked response SHA-256 = %s; pinned Node has %s", got, expected.SHA256)
		}
		var expectedBody string
		if err := json.Unmarshal(expected.Body, &expectedBody); err != nil {
			t.Fatal(err)
		}
		if string(body) != expectedBody {
			t.Fatalf("blocked response body = %q; pinned Node has %q", body, expectedBody)
		}
		if got := stableResponseHeaders(response.Header); !reflect.DeepEqual(got, expected.Headers) {
			t.Fatalf("blocked response headers = %#v; pinned Node has %#v", got, expected.Headers)
		}
	})
	t.Run("X-Real-IP takes priority over X-Forwarded-For", func(t *testing.T) {
		request, err := http.NewRequest(http.MethodGet, "http://"+address+"/version", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("X-Real-IP", "127.0.0.1")
		request.Header.Set("X-Forwarded-For", "198.51.100.42")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		expected := fixture.HTTP.Responses["GET /version (X-Real-IP priority)"]
		if response.StatusCode != expected.Status || response.Header.Get("Content-Type") != expected.ContentType {
			t.Fatalf("priority response = %d %q; pinned Node has %d %q", response.StatusCode, response.Header.Get("Content-Type"), expected.Status, expected.ContentType)
		}
		if len(body) != expected.Bytes || sha256Hex(body) != expected.SHA256 {
			t.Fatalf("priority response body size/hash = %d/%s; pinned Node has %d/%s", len(body), sha256Hex(body), expected.Bytes, expected.SHA256)
		}
		var expectedBody string
		if err := json.Unmarshal(expected.Body, &expectedBody); err != nil {
			t.Fatal(err)
		}
		if string(body) != expectedBody {
			t.Fatalf("priority response body = %q; pinned Node has %q", body, expectedBody)
		}
		if got := stableResponseHeaders(response.Header); !reflect.DeepEqual(got, expected.Headers) {
			t.Fatalf("priority response headers = %#v; pinned Node has %#v", got, expected.Headers)
		}
	})
}

func TestStartHostWhitelistMatchesPinnedNodeHTTPResponses(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-host-whitelist.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture hostWhitelistHTTPFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("host-whitelist oracle baseline = %+v", fixture.Baseline)
	}

	installRoot := t.TempDir()
	configLines := []string{
		"whitelistMode: true",
		"whitelist:",
		"  - 127.0.0.1",
		"hostWhitelist:",
		"  enabled: " + strconv.FormatBool(fixture.Inputs.HostWhitelistEnabled),
		"  scan: " + strconv.FormatBool(fixture.Inputs.HostWhitelistScan),
		"  hosts:",
	}
	for _, host := range fixture.Inputs.Hosts {
		configLines = append(configLines, "    - "+host)
	}
	config := strings.Join(append(configLines, ""), "\n")
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	port := availableIPv4Port(t)
	running, err := Start(StartOptions{
		Args: []string{
			"--enableIPv4", "true", "--enableIPv6", "false", "--listen", "false",
			"--port", strconv.Itoa(port), "--heartbeatInterval", "0", "--browserLaunchEnabled", "false",
		},
		WorkingDirectory:         installRoot,
		InstallRoot:              installRoot,
		Now:                      time.UnixMilli(1735689600000),
		WaitBeforeLegacyDataMove: func(time.Duration) {},
		InterfaceAddresses:       []net.Addr{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := running.Close(ctx); err != nil {
			t.Errorf("close GoTavern server: %v", err)
		}
	})
	if !running.StartedIPv4 || running.StartedIPv6 || len(running.ListenerFailures) != 0 {
		t.Fatalf("listener result = IPv4 %t, IPv6 %t, failures %+v", running.StartedIPv4, running.StartedIPv6, running.ListenerFailures)
	}

	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 20 * time.Second}
	address := running.Listeners()[0].Addr().String()
	_, serverPort, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatalf("split listener address %q: %v", address, err)
	}
	for name, expected := range fixture.Observations {
		if name == "customErrorPageReadPerRequest" {
			continue
		}
		t.Run(name, func(t *testing.T) {
			host := strings.ReplaceAll(expected.Host, "<port>", serverPort)
			assertHostWhitelistResponse(t, client, address, host, expected)
		})
	}

	customErrorPage := []byte(fixture.Inputs.CustomErrorPage)
	hostErrorPagePath := filepath.Join(running.CommandLine.Paths.RuntimeDataRoot, "_errors", "host-not-allowed.html")
	if err := os.WriteFile(hostErrorPagePath, customErrorPage, 0o644); err != nil {
		t.Fatal(err)
	}
	expected := fixture.Observations["customErrorPageReadPerRequest"]
	t.Run("customErrorPageReadPerRequest", func(t *testing.T) {
		assertHostWhitelistResponse(t, client, address, expected.Host, expected)
	})
}

func TestStartHeartbeatMatchesPinnedNodeLifecycle(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-heartbeat.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture heartbeatFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("heartbeat oracle baseline = %+v", fixture.Baseline)
	}

	installRoot := t.TempDir()
	port := availableIPv4Port(t)
	running, err := Start(StartOptions{
		Args: []string{
			"--enableIPv4", "true", "--enableIPv6", "false", "--listen", "false",
			"--port", strconv.Itoa(port), "--heartbeatInterval", strconv.FormatFloat(fixture.Inputs.IntervalSeconds, 'f', -1, 64),
			"--browserLaunchEnabled", "false",
		},
		WorkingDirectory:         installRoot,
		InstallRoot:              installRoot,
		Now:                      time.UnixMilli(1735689600000),
		WaitBeforeLegacyDataMove: func(time.Duration) {},
		InterfaceAddresses:       []net.Addr{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := running.Close(ctx); err != nil {
			t.Errorf("close GoTavern server: %v", err)
		}
	})

	heartbeatPath := filepath.Join(running.CommandLine.Paths.RuntimeDataRoot, "heartbeat.json")
	firstTimestamp := readHeartbeatTimestamp(t, heartbeatPath, fixture.Observations.Immediate.FilePresent, fixture.Observations.Immediate.Keys, fixture.Observations.Immediate.Timestamp)
	interval := time.Duration(fixture.Inputs.IntervalSeconds * float64(time.Second))
	time.Sleep(interval * 4)
	updatedTimestamp := readHeartbeatTimestamp(t, heartbeatPath, fixture.Observations.Immediate.FilePresent, fixture.Observations.Periodic.Keys, fixture.Observations.Immediate.Timestamp)
	if !fixture.Observations.Periodic.TimestampChanged || updatedTimestamp <= firstTimestamp {
		t.Fatalf("heartbeat timestamp changed from %d to %d; pinned Node changed=%t", firstTimestamp, updatedTimestamp, fixture.Observations.Periodic.TimestampChanged)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := running.Close(ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(interval * 3)
	stoppedTimestamp := readHeartbeatTimestamp(t, heartbeatPath, fixture.Observations.AfterShutdown.FilePresent, fixture.Observations.Immediate.Keys, fixture.Observations.Immediate.Timestamp)
	if !fixture.Observations.AfterShutdown.TimestampUnchangedAfter || stoppedTimestamp != updatedTimestamp {
		t.Fatalf("heartbeat timestamp after shutdown = %d; before shutdown = %d; pinned Node unchanged=%t", stoppedTimestamp, updatedTimestamp, fixture.Observations.AfterShutdown.TimestampUnchangedAfter)
	}
}

func readHeartbeatTimestamp(t *testing.T, heartbeatPath string, filePresent bool, expectedKeys []string, timestampType string) int64 {
	t.Helper()
	body, err := os.ReadFile(heartbeatPath)
	if err != nil {
		if filePresent {
			t.Fatalf("read heartbeat file: %v", err)
		}
		return 0
	}
	if !filePresent {
		t.Fatal("heartbeat file exists; pinned Node does not write it for this setting")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("decode heartbeat JSON %q: %v", body, err)
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if !reflect.DeepEqual(keys, expectedKeys) {
		t.Fatalf("heartbeat JSON keys = %#v; pinned Node has %#v", keys, expectedKeys)
	}
	var timestamp int64
	if err := json.Unmarshal(fields["timestamp"], &timestamp); err != nil {
		t.Fatalf("decode heartbeat timestamp %q: %v", fields["timestamp"], err)
	}
	if timestampType != "number" || timestamp <= 0 {
		t.Fatalf("heartbeat timestamp = %d; pinned Node type is %q", timestamp, timestampType)
	}
	return timestamp
}

func assertHostWhitelistResponse(t *testing.T, client *http.Client, address, host string, expected struct {
	Host        string            `json:"host"`
	Headers     map[string]string `json:"headers"`
	Status      int               `json:"status"`
	ContentType string            `json:"contentType"`
	Bytes       int               `json:"bytes"`
	SHA256      string            `json:"sha256"`
	Body        string            `json:"body"`
}) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, "http://"+address+"/version", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Host = host
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != expected.Status || response.Header.Get("Content-Type") != expected.ContentType {
		t.Fatalf("response = %d %q; pinned Node has %d %q", response.StatusCode, response.Header.Get("Content-Type"), expected.Status, expected.ContentType)
	}
	if len(body) != expected.Bytes || sha256Hex(body) != expected.SHA256 || string(body) != expected.Body {
		t.Fatalf("response body = %d bytes/%s/%q; pinned Node has %d bytes/%s/%q", len(body), sha256Hex(body), body, expected.Bytes, expected.SHA256, expected.Body)
	}
	gotHeaders := stableResponseHeaders(response.Header)
	if len(response.TransferEncoding) > 0 {
		gotHeaders["transfer-encoding"] = strings.Join(response.TransferEncoding, ", ")
	}
	if !reflect.DeepEqual(gotHeaders, expected.Headers) {
		t.Fatalf("response headers = %#v; pinned Node has %#v", gotHeaders, expected.Headers)
	}
}

func stableResponseHeaders(headers http.Header) map[string]string {
	result := make(map[string]string)
	for name, values := range headers {
		name = strings.ToLower(name)
		if name == "connection" || name == "date" || name == "keep-alive" || name == "x-response-time" || len(values) == 0 {
			continue
		}
		result[name] = strings.Join(values, ", ")
	}
	return result
}

func sha256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func availableIPv4Port(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}
