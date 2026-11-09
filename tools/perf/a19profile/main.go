// a19profile: in-process CPU / heap / allocation profile capture for the alpha.19 perf lane.
//
// WHY THIS EXISTS. internal/server/bench_test.go measures the HTTP handlers in-process, and
// scripts/bench-profiles.mjs runs that set with -cpuprofile/-memprofile. Neither can profile two things the
// alpha.19 brief requires:
//
//  1. STARTUP. The shipped binary has no pprof endpoint and no -cpuprofile flag, and a benchmark never runs
//     the startup pipeline (command-line resolution, data startup, statistics, handler construction). This
//     helper calls the SAME internal/app.Start the binary calls, with runtime/pprof started BEFORE the call,
//     so the profile is the startup path a user pays. GOTAVERN_STARTUP_TRACE=1 is set for the run, so the
//     stage lines from internal/app/startup_trace.go are captured next to the profile as per-stage evidence.
//
//  2. A WARM request path. BenchmarkCharactersAllScale runs N iterations with one cold first iteration, so
//     the allocation profile always mixes the cold card-read path with the warm projection/marshal path.
//     -mode http boots the real server, performs warmup requests, and only THEN starts the profiler, so the
//     profile is the warm steady-state cost the user pays on click 2..N (alpha.18 measured ~485 MB/op warm
//     against 885 MB/op cold, so mixing them hides which half a change moved).
//
// It reuses, never re-implements: the data trees are tests/perf/fixturegen's, the process facts are
// tests/perf/procstat's, and the server is internal/app.Start. It is tooling, not product code.
//
// USAGE
//
//	go build -o a19profile.exe ./tools/perf/a19profile
//	a19profile --mode startup --data-root <tree>/data --config <tree>/config.yaml --out-dir <dir> --label cold-10000
//	a19profile --mode http --route characters --data-root <tree>/data --config <tree>/config.yaml \
//	    --out-dir <dir> --requests 5 --warmup 1 --label warm-cards-10000
//
// Artifacts, per run: <label>-cpu.pb.gz, <label>-heap.pb.gz, <label>.json (timings, stage lines, sample counts,
// route statuses/bytes, Go version, argv, and the environment the numbers came from).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/app"
)

type runArtifact struct {
	Label       string            `json:"label"`
	Mode        string            `json:"mode"`
	GoVersion   string            `json:"goVersion"`
	GOOS        string            `json:"goos"`
	GOARCH      string            `json:"goarch"`
	GOMAXPROCS  int               `json:"gomaxprocs"`
	DataRoot    string            `json:"dataRoot"`
	ConfigPath  string            `json:"configPath"`
	Route       string            `json:"route,omitempty"`
	Requests    int               `json:"requests,omitempty"`
	Warmup      int               `json:"warmup,omitempty"`
	RelayMessages      int        `json:"relayMessages,omitempty"`
	RelayMessageBytes  int        `json:"relayMessageBytes,omitempty"`
	ProviderPeer       string     `json:"providerPeer,omitempty"`
	StartupMs   float64           `json:"startupMs"`
	ReadyMs     float64           `json:"readyMs"`
	Stages      []string          `json:"startupStageLines"`
	RequestRows []requestRow      `json:"requestRows,omitempty"`
	CPUProfile  string            `json:"cpuProfile"`
	HeapProfile string            `json:"heapProfile"`
	CPUHz       int               `json:"cpuProfileRateHz"`
	Notes       []string          `json:"notes"`
	StartedAt   string            `json:"startedAt"`
	FinishedAt  string            `json:"finishedAt"`
}

type requestRow struct {
	Index    int     `json:"index"`
	Kind     string  `json:"kind"`
	Status   int     `json:"status"`
	Bytes    int     `json:"bytes"`
	Millis   float64 `json:"ms"`
	Route    string  `json:"route"`
	InWindow bool    `json:"inProfileWindow"`
}

// captureWriter records the app's startup stage lines (GOTAVERN_STARTUP_TRACE=1) without writing them to the
// console, so a stage line and the profile share one artifact.
type captureWriter struct{ lines []string }

func (writer *captureWriter) Write(p []byte) (int, error) {
	for _, line := range strings.Split(strings.TrimSuffix(string(p), "\n"), "\n") {
		if line != "" {
			writer.lines = append(writer.lines, line)
		}
	}
	return len(p), nil
}

func main() {
	mode := flag.String("mode", "http", "startup|http")
	dataRoot := flag.String("data-root", "", "generated data root (tests/perf/fixturegen --out <tree>)")
	configPath := flag.String("config", "", "config.yaml path (default: <tree>/config.yaml)")
	installRoot := flag.String("install-root", "", "server install root (default: the directory that holds this helper)")
	outDir := flag.String("out-dir", "", "artifact directory (required)")
	label := flag.String("label", "", "artifact label (required)")
	route := flag.String("route", "characters", "characters|worlds|world-get|settings|chats|chat-get|chat-recent")
	requests := flag.Int("requests", 5, "profiled requests (http/relay mode)")
	warmup := flag.Int("warmup", 1, "warmup requests before profiling (http/relay mode)")
	relayMessages := flag.Int("relay-messages", 6, "relay mode: messages in the generated request")
	relayMessageBytes := flag.Int("relay-message-bytes", 512, "relay mode: bytes of prose per generated message")
	flag.Parse()

	if *dataRoot == "" || *outDir == "" || *label == "" {
		fmt.Fprintln(os.Stderr, "a19profile: --data-root, --out-dir and --label are required")
		os.Exit(2)
	}
	if *configPath == "" {
		*configPath = filepath.Join(filepath.Dir(filepath.Clean(*dataRoot)), "config.yaml")
	}
	if *installRoot == "" {
		executable, err := os.Executable()
		if err != nil {
			fmt.Fprintf(os.Stderr, "a19profile: resolve executable: %v\n", err)
			os.Exit(2)
		}
		*installRoot = filepath.Dir(executable)
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "a19profile: create out dir: %v\n", err)
		os.Exit(2)
	}

	artifact := runArtifact{
		Label:      *label,
		Mode:       *mode,
		GoVersion:  runtime.Version(),
		GOOS:       runtime.GOOS,
		GOARCH:     runtime.GOARCH,
		GOMAXPROCS: runtime.GOMAXPROCS(0),
		DataRoot:   *dataRoot,
		ConfigPath: *configPath,
		Route:      *route,
		Requests:   *requests,
		Warmup:     *warmup,
		CPUHz:      100,
		StartedAt:  time.Now().UTC().Format(time.RFC3339),
		Notes: []string{
			"CPU profile rate is Go's default 100 Hz; short windows carry few samples and are reported with their sample counts.",
			"Heap profile carries alloc_space/alloc_objects (cumulative) and inuse_space/inuse_objects (after a forced GC at capture); the two are never mixed.",
			"All OCUMULATIVE allocation totals include the startup path and the warmup requests; a warm-window claim is about the SHAPE of the profile, and the per-request allocation numbers come from internal/server/bench_test.go.",
			"This helper calls internal/app.Start in-process; it is not the packaged binary and does not measure process exec/init cost (tools/perf/a19-boot.mjs does that).",
		},
	}
	cpuPath := filepath.Join(*outDir, *label+"-cpu.pb.gz")
	heapPath := filepath.Join(*outDir, *label+"-heap.pb.gz")
	artifact.CPUProfile = filepath.Base(cpuPath)
	artifact.HeapProfile = filepath.Base(heapPath)

	trace := &captureWriter{}
	args := []string{
		"start",
		"--port", "0",
		"--dataRoot", *dataRoot,
		"--configPath", *configPath,
		"--browserLaunchEnabled", "false",
		"--listen", "false",
		"--enableIPv4", "true",
		"--enableIPv6", "false",
		"--listenAddressIPv4", "127.0.0.1",
		"--heartbeatInterval", "0",
	}
	os.Setenv("GOTAVERN_STARTUP_TRACE", "1")

	port := freePort()
	args[2] = fmt.Sprint(port)

	if *mode == "startup" {
		cpuFile, err := os.Create(cpuPath)
		if err != nil { fail("create cpu profile: %v", err) }
		if err := pprof.StartCPUProfile(cpuFile); err != nil { fail("start cpu profile: %v", err) }
		started := time.Now()
		running, err := app.Start(app.StartOptions{
			Args:             args,
			WorkingDirectory: filepath.Dir(*configPath),
			InstallRoot:      *installRoot,
			StartupTrace:     trace,
		})
		artifact.StartupMs = float64(time.Since(started).Microseconds()) / 1000
		pprof.StopCPUProfile()
		_ = cpuFile.Close()
		if err != nil {
			fail("app.Start: %v", err)
		}
		// Readiness is measured with the same raw HTTP round trip a client uses; Start returning is the
		// handler/listener-ready point, and GET /version must answer on it.
		artifact.ReadyMs = timeToReady(port)
		writeHeap(heapPath)
		closeServer(running)
	} else if *mode == "http" {
		started := time.Now()
		running, err := app.Start(app.StartOptions{
			Args:             args,
			WorkingDirectory: filepath.Dir(*configPath),
			InstallRoot:      *installRoot,
			StartupTrace:     trace,
		})
		artifact.StartupMs = float64(time.Since(started).Microseconds()) / 1000
		if err != nil {
			fail("app.Start: %v", err)
		}
		origin := fmt.Sprintf("http://127.0.0.1:%d", port)
		client, err := newSession(origin)
		if err != nil { fail("session: %v", err) }
		artifact.ReadyMs = timeToReady(port)
		request := requestForRoute(*route)
		for index := 0; index < *warmup; index++ {
			row, err := client.do(request)
			if err != nil { fail("warmup request: %v", err) }
			row.Index = index
			row.Kind = "warmup"
			artifact.RequestRows = append(artifact.RequestRows, row)
		}
		cpuFile, err := os.Create(cpuPath)
		if err != nil { fail("create cpu profile: %v", err) }
		if err := pprof.StartCPUProfile(cpuFile); err != nil { fail("start cpu profile: %v", err) }
		for index := 0; index < *requests; index++ {
			row, err := client.do(request)
			if err != nil { fail("profiled request: %v", err) }
			row.Index = index
			row.Kind = "profiled"
			row.InWindow = true
			artifact.RequestRows = append(artifact.RequestRows, row)
		}
		pprof.StopCPUProfile()
		_ = cpuFile.Close()
		writeHeap(heapPath)
		closeServer(running)
	} else if *mode == "relay" {
		peer := httptest.NewServer(relayPeer())
		defer peer.Close()
		started := time.Now()
		running, err := app.Start(app.StartOptions{
			Args:             args,
			WorkingDirectory: filepath.Dir(*configPath),
			InstallRoot:      *installRoot,
			StartupTrace:     trace,
		})
		artifact.StartupMs = float64(time.Since(started).Microseconds()) / 1000
		if err != nil {
			fail("app.Start: %v", err)
		}
		origin := fmt.Sprintf("http://127.0.0.1:%d", port)
		client, err := newSession(origin)
		if err != nil {
			fail("session: %v", err)
		}
		artifact.ReadyMs = timeToReady(port)
		artifact.Route = "/api/backends/chat-completions/generate"
		artifact.RelayMessages = *relayMessages
		artifact.RelayMessageBytes = *relayMessageBytes
		artifact.ProviderPeer = peer.URL
		request := httpRequest{
			Method: http.MethodPost,
			Route:  "/api/backends/chat-completions/generate",
			Body:   relayRequestBody(peer.URL, *relayMessages, *relayMessageBytes),
		}
		for index := 0; index < *warmup; index++ {
			row, err := client.do(request)
			if err != nil {
				fail("warmup relay request: %v", err)
			}
			row.Index = index
			row.Kind = "warmup"
			artifact.RequestRows = append(artifact.RequestRows, row)
		}
		cpuFile, err := os.Create(cpuPath)
		if err != nil {
			fail("create cpu profile: %v", err)
		}
		if err := pprof.StartCPUProfile(cpuFile); err != nil {
			fail("start cpu profile: %v", err)
		}
		for index := 0; index < *requests; index++ {
			row, err := client.do(request)
			if err != nil {
				fail("profiled relay request: %v", err)
			}
			row.Index = index
			row.Kind = "profiled"
			row.InWindow = true
			artifact.RequestRows = append(artifact.RequestRows, row)
		}
		pprof.StopCPUProfile()
		_ = cpuFile.Close()
		writeHeap(heapPath)
		closeServer(running)
	} else {
		fail("--mode must be startup|http|relay")
	}
	artifact.Stages = trace.lines
	artifact.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	encoded, err := json.MarshalIndent(artifact, "", "  ")
	if err != nil { fail("encode artifact: %v", err) }
	if err := os.WriteFile(filepath.Join(*outDir, *label+".json"), append(encoded, '\n'), 0o644); err != nil {
		fail("write artifact: %v", err)
	}
	fmt.Printf("a19profile: %s startup=%.1fms ready=%.1fms rows=%d -> %s\n", *label, artifact.StartupMs, artifact.ReadyMs, len(artifact.RequestRows), filepath.Join(*outDir, *label+".json"))
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "a19profile: "+format+"\n", args...)
	os.Exit(1)
}

func freePort() int {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		fail("reserve a loopback port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}

func timeToReady(port int) float64 {
	started := time.Now()
	deadline := started.Add(30 * time.Second)
	for time.Now().Before(deadline) {
		connection, err := net.DialTimeout("tcp4", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			_ = connection.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
			_, _ = io.WriteString(connection, "GET /version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
			buffer := make([]byte, 64)
			n, _ := connection.Read(buffer)
			_ = connection.Close()
			if n > 0 && strings.HasPrefix(string(buffer[:n]), "HTTP/1.1 200") {
				return float64(time.Since(started).Microseconds()) / 1000
			}
		}
		time.Sleep(time.Millisecond)
	}
	return -1
}

func writeHeap(path string) {
	runtime.GC()
	file, err := os.Create(path)
	if err != nil { fail("create heap profile: %v", err) }
	defer func() { _ = file.Close() }()
	if err := pprof.WriteHeapProfile(file); err != nil { fail("write heap profile: %v", err) }
}

func closeServer(running *app.RunningServer) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = running.Close(ctx)
}

// relayPeer is a deterministic OpenAI-compatible SSE peer. It is the provider end of the relay measurement:
// a fixed four-event stream (three deltas and [DONE]) with every event flushed, so the GoTavern side parses a
// real chunked SSE response rather than one buffered body. It defines NOTHING about correctness: the provider
// wire is asserted by the committed replay fixtures, not by this perf peer.
func relayPeer() http.Handler {
	const script = "data: {\"id\":\"a19-perf\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"alpha \"},\"finish_reason\":null}]}\n\n" +
		"data: {\"id\":\"a19-perf\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"beta \"},\"finish_reason\":null}]}\n\n" +
		"data: {\"id\":\"a19-perf\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"gamma\"},\"finish_reason\":null}]}\n\n" +
		"data: {\"id\":\"a19-perf\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
		"data: [DONE]\n\n"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		for _, event := range strings.SplitAfter(script, "\n\n") {
			if event == "" {
				continue
			}
			_, _ = io.WriteString(w, event)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
	})
}

type relayRequestMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type relayRequestBodyShape struct {
	ChatCompletionSource string               `json:"chat_completion_source"`
	Model                string               `json:"model"`
	Messages             []relayRequestMessage `json:"messages"`
	MaxTokens            int                  `json:"max_tokens"`
	Temperature          float64              `json:"temperature"`
	ReverseProxy         string               `json:"reverse_proxy"`
	ProxyPassword        string               `json:"proxy_password"`
	Stream               bool                 `json:"stream"`
}

// relayRequestBody builds the pinned request shape the frontend sends for a streaming generation against a
// custom OpenAI-compatible endpoint (reverse_proxy is the documented pinned seam; chat-completions.js:1788).
func relayRequestBody(peerURL string, messages, bytesPerMessage int) string {
	prose := strings.Repeat("g", bytesPerMessage)
	body := relayRequestBodyShape{
		ChatCompletionSource: "openai",
		Model:                "a19-perf-model",
		MaxTokens:            256,
		Temperature:          0.5,
		ReverseProxy:         peerURL,
		ProxyPassword:        "synthetic-perf-key",
		Stream:               true,
	}
	if messages < 1 {
		messages = 1
	}
	body.Messages = make([]relayRequestMessage, 0, messages)
	body.Messages = append(body.Messages, relayRequestMessage{Role: "system", Content: "a19 relay perf system marker"})
	for index := 1; index < messages; index++ {
		role := "user"
		if index%2 == 0 {
			role = "assistant"
		}
		body.Messages = append(body.Messages, relayRequestMessage{Role: role, Content: prose})
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		fail("encode relay request body: %v", err)
	}
	return string(encoded)
}

type httpRequest struct {
	Method string
	Route  string
	Body   string
}

func requestForRoute(route string) httpRequest {
	switch route {
	case "worlds":
		return httpRequest{Method: http.MethodPost, Route: "/api/worldinfo/list", Body: "{}"}
	case "world-get":
		return httpRequest{Method: http.MethodPost, Route: "/api/worldinfo/get", Body: `{"name":"A15 World 00000"}`}
	case "settings":
		return httpRequest{Method: http.MethodPost, Route: "/api/settings/get", Body: "{}"}
	case "chats":
		return httpRequest{Method: http.MethodPost, Route: "/api/characters/chats", Body: `{"avatar_url":"A15 Character.png"}`}
	case "chat-get":
		return httpRequest{Method: http.MethodPost, Route: "/api/chats/get", Body: `{"avatar_url":"A15 Character.png","file_name":"A15 Chat 0000"}`}
	case "chat-recent":
		return httpRequest{Method: http.MethodPost, Route: "/api/chats/recent", Body: `{"max":20}`}
	default:
		return httpRequest{Method: http.MethodPost, Route: "/api/characters/all", Body: "{}"}
	}
}

type session struct {
	client *http.Client
	origin string
	token  string
}

func newSession(origin string) (*session, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	result := &session{client: &http.Client{Jar: jar, Timeout: 120 * time.Second}, origin: origin}
	response, err := result.client.Get(origin + "/csrf-token")
	if err != nil {
		return nil, fmt.Errorf("GET /csrf-token: %w", err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(body, &token); err != nil {
		return nil, fmt.Errorf("decode /csrf-token: %w", err)
	}
	result.token = token.Token
	if result.token == "" {
		return nil, fmt.Errorf("/csrf-token returned no token: %s", strings.TrimSpace(string(body)))
	}
	return result, nil
}

func (session *session) do(request httpRequest) (requestRow, error) {
	started := time.Now()
	httpRequest, err := http.NewRequest(request.Method, session.origin+request.Route, strings.NewReader(request.Body))
	if err != nil {
		return requestRow{}, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("X-CSRF-Token", session.token)
	response, err := session.client.Do(httpRequest)
	if err != nil {
		return requestRow{}, err
	}
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil {
		return requestRow{}, readErr
	}
	return requestRow{
		Status: response.StatusCode,
		Bytes:  len(body),
		Millis: float64(time.Since(started).Microseconds()) / 1000,
		Route:  request.Route,
	}, nil
}
