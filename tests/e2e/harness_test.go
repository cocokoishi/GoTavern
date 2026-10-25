package e2e

// THE SUBPROCESS END-TO-END HARNESS: a REAL GoTavern binary, a REAL HTTP route, a REAL provider
// socket, and the PRODUCTION transport.
//
// WHY A SUBPROCESS. internal/server's test binary pins the wire-exact client for the whole process
// (internal/server/transport_mode_test.go), so a test that lives in that package -- or that drives its
// handlers directly -- cannot say anything about the client that carries user traffic. The route's
// handlers are deliberately NOT exported for tests, so the only honest way to reach the production path
// is to boot the shipped binary and talk to it over a socket. This package therefore has no TestMain
// and sets no seam; requireProductionTransport refuses to run when the seam is in the environment,
// because a green from that process would be a green about the wrong client (AGENTS.md rule 7).
//
// WHAT THE PEER PROVES. The recording peer is tests/mockprovider, which records the bytes it RECEIVED
// rather than a reconstruction of them. The two transports are distinguishable at that peer by three
// headers, and none of them is a choice either client makes freely:
//
//   - accept-encoding: the production client DROPS the planner's `gzip, deflate, br` (it must, or
//     net/http will not decompress for it) and advertises exactly `gzip`; the wire-exact client writes
//     the planner's value verbatim.
//   - connection: every planner sets `Connection: close` (node-fetch's value, which the wire-exact
//     client reproduces); net/http sends no Connection header and keeps the connection alive.
//   - header casing: net/http canonicalises header names, so the peer records `Content-Type`; the
//     wire-exact client writes the planner's lowercase `content-type`.
//
// If any of those three is missing the process under test was NOT carrying the request on the
// production transport, so the end-to-end assertion cannot pass for the wrong reason.
//
// READINESS IS POLLED, NEVER SLEPT ON (rule 33). /version is SillyTavern's compatibility endpoint and
// the cheapest route that proves the HTTP listener is serving; the poll has a hard deadline and, when
// it expires, the child's own output is printed so the failure names itself instead of reading as a
// timeout.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	// binaryEnv points the harness at a CI-built binary. The lane workflow builds one for the commit
	// under test and exports this, so the binary that is driven IS the artifact; when it is absent the
	// harness compiles ./cmd/gotavern itself, which keeps the test meaningful on a machine that has the
	// toolchain.
	binaryEnv = "GOTAVERN_BINARY"

	// transportSeamEnv is the seam that puts the WIRE-EXACT client on the user path for
	// internal/server's own test binary. It must be absent here; see requireProductionTransport.
	transportSeamEnv = "GOTAVERN_OUTBOUND_WIRE_EXACT"

	// readinessPath is the compatibility endpoint used as the readiness probe. It is a real route, it
	// needs no session, and it answers only once the HTTP listener is serving.
	readinessPath = "/version"

	bootDeadline     = 120 * time.Second
	bootPollInterval = 200 * time.Millisecond
)

// requireProductionTransport refuses to run in a process where the wire-exact seam is set. A test that
// claims "the production transport carried this request" cannot make that claim in a process that was
// told to use the measuring instrument, and refusing is the only outcome that is not a false green.
func requireProductionTransport(t *testing.T) {
	t.Helper()
	// The production code reads this seam as exactly "1" (internal/outbound/transport.go:79), so the
	// refusal uses the same rule: any other value cannot divert a request, and failing on one would be
	// a red about the harness rather than about the product.
	value := os.Getenv(transportSeamEnv)
	if value == "1" {
		t.Fatalf("%s=1 is set in this test process: this harness must observe the PRODUCTION transport, "+
			"and the wire-exact client cannot stand in for it. Unset it and re-run.", transportSeamEnv)
	}
	if value != "" {
		t.Logf("note: %s=%q is set, but the production code reads only \"1\", so provider traffic still "+
			"uses the production transport", transportSeamEnv, value)
	}
}

// capturedOutput is the child's output, safe to read while the child is still writing.
type capturedOutput struct {
	mu   sync.Mutex
	body bytes.Buffer
}

func (captured *capturedOutput) Write(payload []byte) (int, error) {
	captured.mu.Lock()
	defer captured.mu.Unlock()
	return captured.body.Write(payload)
}

func (captured *capturedOutput) String() string {
	captured.mu.Lock()
	defer captured.mu.Unlock()
	return captured.body.String()
}

// serverProcess is one booted GoTavern.
type serverProcess struct {
	origin   string
	install  string
	dataRoot string
	stdout   *capturedOutput
	stderr   *capturedOutput

	command *exec.Cmd
	exitCh  chan struct{}

	stateMu sync.Mutex
	exitErr error
	exited  bool
}

func (server *serverProcess) exitState() (error, bool) {
	server.stateMu.Lock()
	defer server.stateMu.Unlock()
	return server.exitErr, server.exited
}

// diagnostic is what a failing assertion prints: the child's own view, stderr first because that is
// where a startup refusal writes.
func (server *serverProcess) diagnostic() string {
	return fmt.Sprintf("install root: %s\ndata root: %s\n--- child stderr ---\n%s\n--- child stdout ---\n%s",
		server.install, server.dataRoot, server.stderr.String(), server.stdout.String())
}

// stop ends the child and waits for it, so no process outlives the test.
func (server *serverProcess) stop() {
	if _, exited := server.exitState(); !exited {
		_ = server.command.Process.Kill()
	}
	select {
	case <-server.exitCh:
	case <-time.After(30 * time.Second):
	}
}

// moduleRoot is the repository root, which is where `go build ./cmd/gotavern` must run. The test's
// working directory is this package's directory, so it is two levels up; the absolute path is taken
// first because a relative command path resolves against the process working directory rather than
// against anything this test changes.
func moduleRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve the module root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("%s does not look like the module root (no go.mod): %v", root, err)
	}
	return root
}

// resolveBinary returns a path to a gotavern executable INSIDE the install root, because the binary
// derives its install root from `filepath.Dir(os.Executable())` (cmd/gotavern/main.go:170) and the
// assets, the config and data/ are laid out the way a release is.
func resolveBinary(t *testing.T, installRoot string) string {
	t.Helper()
	target := filepath.Join(installRoot, "gotavern")
	if runtime.GOOS == "windows" {
		target += ".exe"
	}
	if provided := strings.TrimSpace(os.Getenv(binaryEnv)); provided != "" {
		source, err := filepath.Abs(provided)
		if err != nil {
			t.Fatalf("%s=%q is not a usable path: %v", binaryEnv, provided, err)
		}
		if _, err := os.Stat(source); err != nil {
			t.Fatalf("%s points at %s, which does not exist: %v. The lane workflow builds that binary "+
				"and exports this variable; on a machine with the Go toolchain, leave it unset.", binaryEnv, source, err)
		}
		if err := copyExecutable(source, target); err != nil {
			t.Fatalf("copy %s into the install root: %v", source, err)
		}
		t.Logf("%s: driving the binary at %s (copied into the install root %s)", binaryEnv, source, installRoot)
		return target
	}

	build := exec.Command("go", "build", "-trimpath", "-o", target, "./cmd/gotavern")
	build.Dir = moduleRoot(t)
	output, err := build.CombinedOutput()
	if err != nil {
		t.Fatalf("go build ./cmd/gotavern failed, and this test boots the REAL binary rather than "+
			"stubbing the route: %v\n%s", err, output)
	}
	t.Logf("%s is unset: built %s from this tree", binaryEnv, target)
	return target
}

func copyExecutable(source, target string) error {
	payload, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(target, payload, 0o755)
}

// childEnvironment builds the child's environment explicitly: the parent's, minus the transport seam,
// plus what this harness supplies. The seam is removed case-insensitively so a Windows parent cannot
// leak it to a child through a differently-cased name.
func childEnvironment(extra map[string]string) []string {
	environment := make([]string, 0, len(os.Environ())+len(extra))
	for _, entry := range os.Environ() {
		name := entry
		if index := strings.IndexByte(entry, '='); index >= 0 {
			name = entry[:index]
		}
		if strings.EqualFold(name, transportSeamEnv) {
			continue
		}
		environment = append(environment, entry)
	}
	for name, value := range extra {
		environment = append(environment, name+"="+value)
	}
	return environment
}

// freePort asks the kernel for a port and gives it back. There is a window between the close and the
// child's bind, which is why a collision fails the readiness poll with the child's own output rather
// than being retried with a sleep.
func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a loopback port: %v", err)
	}
	defer listener.Close()
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("loopback listener address = %T, want *net.TCPAddr", listener.Addr())
	}
	return address.Port
}

// bootServer boots the real binary into a release-shaped install root and waits until GET /version is
// served. The flags are the recipe the shipped probes use for both backends (tools/
// probe-provider-wire.mjs:331-335, tools/probe-runtime-roundtrip.mjs:276-284): loopback only, no
// browser launch, and no heartbeat, so nothing outside this test can move.
func bootServer(t *testing.T, extraEnvironment map[string]string) *serverProcess {
	t.Helper()
	installRoot := t.TempDir()
	return bootServerAt(t, installRoot, filepath.Join(installRoot, "data"), extraEnvironment)
}

// bootServerAt is bootServer with the roots chosen by the caller, so a test can boot the shipped binary
// against a tree it built itself -- tests/e2e/longlived_test.go's long-lived user directory -- instead of
// the freshly seeded one this harness invents. Every other caller keeps using bootServer.
func bootServerAt(t *testing.T, installRoot, dataRoot string, extraEnvironment map[string]string) *serverProcess {
	t.Helper()
	binary := resolveBinary(t, installRoot)
	port := freePort(t)

	command := exec.Command(binary, []string{
		"start",
		"--configPath", filepath.Join(installRoot, "config.yaml"),
		"--dataRoot", dataRoot,
		"--listenAddressIPv4", "127.0.0.1",
		"--enableIPv4", "true",
		"--enableIPv6", "false",
		"--listen", "false",
		"--port", strconv.Itoa(port),
		"--browserLaunchEnabled", "false",
		"--heartbeatInterval", "0",
	}...)
	command.Dir = installRoot
	command.Env = childEnvironment(extraEnvironment)
	server := &serverProcess{
		origin:   "http://127.0.0.1:" + strconv.Itoa(port),
		install:  installRoot,
		dataRoot: dataRoot,
		stdout:   &capturedOutput{},
		stderr:   &capturedOutput{},
		command:  command,
		exitCh:   make(chan struct{}),
	}
	command.Stdout = server.stdout
	command.Stderr = server.stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start %s: %v", binary, err)
	}
	go func() {
		err := command.Wait()
		server.stateMu.Lock()
		server.exitErr = err
		server.exited = true
		server.stateMu.Unlock()
		close(server.exitCh)
	}()
	t.Cleanup(server.stop)

	// The harness's own client has no proxy, so a CI proxy variable cannot divert the readiness probe
	// away from loopback (the same guard internal/app/basic_auth_test.go uses).
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 10 * time.Second}
	deadline := time.Now().Add(bootDeadline)
	for {
		if err, exited := server.exitState(); exited {
			t.Fatalf("the server exited before it answered GET %s (%v)\n%s", readinessPath, err, server.diagnostic())
		}
		response, err := client.Get(server.origin + readinessPath)
		if err == nil {
			payload, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if readErr == nil && response.StatusCode == http.StatusOK && len(payload) > 0 {
				t.Logf("server ready at %s after GET %s answered %d %q", server.origin, readinessPath, response.StatusCode, payload)
				return server
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server did not answer GET %s with 200 within %s\n%s", readinessPath, bootDeadline, server.diagnostic())
		}
		time.Sleep(bootPollInterval)
	}
}

// session is a browser-equivalent session: the CSRF token and the signed cookie the frontend holds.
// Every write below goes through the same three steps the frontend uses, because a key that only
// appears for a hand-written file is not the key the product reads.
type session struct {
	origin string
	client *http.Client
	cookie string
	token  string
}

func newSession(origin string) *session {
	// Proxy nil for the same reason as the readiness client: this leg must reach loopback and nothing
	// else, whatever a CI environment exports.
	return &session{origin: origin, client: &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 120 * time.Second}}
}

func (client *session) get(t *testing.T, route string) (int, http.Header, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, client.origin+route, nil)
	if err != nil {
		t.Fatalf("build GET %s: %v", route, err)
	}
	response, err := client.client.Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", route, err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read GET %s: %v", route, err)
	}
	return response.StatusCode, response.Header, string(payload)
}

func (client *session) postJSON(t *testing.T, route, body string) (int, http.Header, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, client.origin+route, strings.NewReader(body))
	if err != nil {
		t.Fatalf("build POST %s: %v", route, err)
	}
	request.Header.Set("Content-Type", "application/json")
	if client.cookie != "" {
		request.Header.Set("Cookie", client.cookie)
	}
	if client.token != "" {
		request.Header.Set("X-CSRF-Token", client.token)
	}
	response, err := client.client.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", route, err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read POST %s: %v", route, err)
	}
	return response.StatusCode, response.Header, string(payload)
}

// cookieHeader joins the Set-Cookie values the way a browser would resend them.
func cookieHeader(values []string) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		name := value
		if index := strings.IndexByte(name, ';'); index >= 0 {
			name = name[:index]
		}
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		parts = append(parts, name)
	}
	return strings.Join(parts, "; ")
}

// openSession performs the handshake the frontend performs before a write on a fresh install:
// GET /csrf-token, and the signed cookie that comes with it.
//
// WHY THERE IS NO LOGIN HERE. The default config has `enableUserAccounts: false`, so the middleware
// binds every request to the built-in default user (internal/server/accounts.go:527-529) and the
// frontend shows no login form; the CSRF token plus its cookie is the whole session a write needs.
// `POST /api/users/login` would additionally require the `_storage/user:default-user` record that
// startup seeds (internal/startup/storage.go:131), so depending on it would make this harness's first
// call race the boot it is trying to measure -- and it would be a step the user never takes.
func openSession(t *testing.T, origin string) *session {
	t.Helper()
	client := newSession(origin)

	status, headers, body := client.get(t, "/csrf-token")
	if status != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d, want 200: %s", status, body)
	}
	token, ok := jsonStringMember(body, "token")
	if !ok || token == "" {
		t.Fatalf("GET /csrf-token did not carry a token: %s", body)
	}
	client.token = token
	client.cookie = cookieHeader(headers.Values("Set-Cookie"))
	if client.cookie == "" {
		t.Fatal("GET /csrf-token set no cookie, so no write below can be authenticated")
	}
	return client
}

// writeSecret stores one API key the way the frontend does: POST /api/secrets/write with
// {key, value, label}, answered with {id}. Writing secrets.json by hand would test the reader against
// a file this harness invented rather than against the product's own write path.
func writeSecret(t *testing.T, client *session, key, value string) string {
	t.Helper()
	payload, err := marshalJSON(map[string]string{"key": key, "value": value, "label": "gotavern e2e"})
	if err != nil {
		t.Fatalf("encode the secrets/write body: %v", err)
	}
	status, _, body := client.postJSON(t, "/api/secrets/write", payload)
	if status != http.StatusOK {
		t.Fatalf("POST /api/secrets/write = %d, want 200: %s", status, body)
	}
	id, ok := jsonStringMember(body, "id")
	if !ok || id == "" {
		t.Fatalf("POST /api/secrets/write did not answer an id: %s", body)
	}
	return id
}

// jsonStringMember reads one top-level string member. It never fails the test: callers decide what a
// missing member means, and a route that answered something unexpected should fail by naming its own
// body rather than by an unmarshal error.
func jsonStringMember(body, name string) (string, bool) {
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		return "", false
	}
	text, ok := decoded[name].(string)
	return text, ok
}

func marshalJSON(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
