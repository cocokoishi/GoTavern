package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// recordingListener wraps a real listener so a test can see that the second-signal path closed it.
type recordingListener struct {
	net.Listener
	closed atomic.Bool
}

func (listener *recordingListener) Close() error {
	listener.closed.Store(true)
	return listener.Listener.Close()
}

// blockingCloseServer is a controllable drain: Close reports that it started and then blocks until the
// test releases it, which is the state a real drain is in while http.Server.Shutdown waits for requests.
type blockingCloseServer struct {
	closeStarted chan struct{}
	release      chan struct{}
	startedOnce  sync.Once
	listeners    []net.Listener
}

func (server *blockingCloseServer) Close(context.Context) error {
	server.startedOnce.Do(func() { close(server.closeStarted) })
	<-server.release
	return nil
}

func (server *blockingCloseServer) Listeners() []net.Listener { return server.listeners }

// TestSecondSignalDuringDrainForcesExit130 is the C-H7 red-first test (the pre-fix failure was the
// message, not the exit code): a second signal while the drain is in progress must return
// forcedShutdown, whose ExitCode is 130, and close the listeners.
func TestSecondSignalDuringDrainForcesExit130(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	recorded := &recordingListener{Listener: listener}
	server := &blockingCloseServer{
		closeStarted: make(chan struct{}),
		release:      make(chan struct{}),
		listeners:    []net.Listener{recorded},
	}
	defer close(server.release)

	signals := make(chan os.Signal, 1)
	var stderr bytes.Buffer
	returned := make(chan error, 1)
	go func() { returned <- shutdownAfterSignal(server, os.Interrupt, signals, &stderr) }()

	select {
	case <-server.closeStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("the drain never started")
	}
	signals <- syscall.SIGTERM

	var shutdownErr error
	select {
	case shutdownErr = <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdownAfterSignal did not return after the second signal")
	}
	var forced forcedShutdown
	if !errors.As(shutdownErr, &forced) {
		t.Fatalf("second signal returned %v, want forcedShutdown", shutdownErr)
	}
	if forced.ExitCode() != 130 {
		t.Errorf("forced shutdown exit code = %d, want 130 (128+SIGINT)", forced.ExitCode())
	}
	if !recorded.closed.Load() {
		t.Error("the second signal did not close the listeners")
	}
	message := stderr.String()
	if !strings.Contains(message, "Force closing after") {
		t.Errorf("stderr = %q, want the forced-shutdown line", message)
	}
	// THE TRUTHFULNESS ASSERTION. listener.Close cannot abort an established connection's handler (the
	// next test proves it directly), so the printed line must not claim it does; it may only promise the
	// abort at the point the process actually exits.
	if strings.Contains(message, "requests are aborted") {
		t.Errorf("stderr = %q, still claims closing listeners aborts in-flight requests", message)
	}
	for _, want := range []string{"listeners now", "exits 130"} {
		if !strings.Contains(message, want) {
			t.Errorf("stderr = %q, want it to say %q", message, want)
		}
	}
}

// TestListenerCloseDoesNotAbortInFlightRequest proves the premise of the message correction with a real
// listener and a real keep-alive request: closing the listener (all a second signal does to the socket
// state) leaves a running handler and its connection alone. The request completes normally afterwards.
func TestListenerCloseDoesNotAbortInFlightRequest(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var enteredOnce sync.Once
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		enteredOnce.Do(func() { close(entered) })
		<-release
		response.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(response, "completed")
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()

	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 10 * time.Second}
	type result struct {
		status int
		body   string
		err    error
	}
	completed := make(chan result, 1)
	go func() {
		response, requestErr := client.Get("http://" + listener.Addr().String() + "/stuck")
		if requestErr != nil {
			completed <- result{err: requestErr}
			return
		}
		defer response.Body.Close()
		body, readErr := io.ReadAll(response.Body)
		completed <- result{status: response.StatusCode, body: string(body), err: readErr}
	}()

	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the in-flight request never reached the handler")
	}
	if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Fatalf("listener.Close: %v", err)
	}
	select {
	case outcome := <-completed:
		t.Fatalf("closing the listener ended the in-flight request (%+v); the second-signal message must not claim it aborts requests", outcome)
	case <-time.After(150 * time.Millisecond):
		// Still running: listener.Close did not abort it.
	}
	close(release)
	select {
	case outcome := <-completed:
		if outcome.err != nil {
			t.Fatalf("in-flight request after listener.Close = %v, want it to complete", outcome.err)
		}
		if outcome.status != http.StatusOK || outcome.body != "completed" {
			t.Fatalf("in-flight request = %d %q, want 200 \"completed\"", outcome.status, outcome.body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the in-flight request did not complete after the handler was released")
	}
}

const processExitHelperEnv = "GOTAVERN_TEST_PROCESS_EXIT_HELPER"

// TestProcessExitAbortsInFlightRequest completes the C-H7 claim: it is the os.Exit path, not
// listener.Close, that aborts in-flight requests. The child process is this test binary re-executed as a
// helper: it serves one request whose handler announces itself on stdout and then calls os.Exit(130),
// exactly the process exit the forced-shutdown path performs (main's forcedShutdown branch). The client
// in this process must see the request fail, not complete, and the child must exit 130.
func TestProcessExitAbortsInFlightRequest(t *testing.T) {
	if os.Getenv(processExitHelperEnv) == "1" {
		runProcessExitHelper()
		return
	}

	command := exec.Command(os.Args[0], "-test.run=^TestProcessExitAbortsInFlightRequest$")
	command.Env = append(os.Environ(), processExitHelperEnv+"=1")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var childStderr bytes.Buffer
	command.Stderr = &childStderr
	if err := command.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	reader := bufio.NewReader(stdout)
	addressLine, err := reader.ReadString('\n')
	if err != nil {
		_ = command.Wait()
		t.Fatalf("helper did not announce its address (%v); stderr: %s", err, childStderr.String())
	}
	address := strings.TrimSpace(addressLine)

	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 10 * time.Second}
	requestErr := make(chan error, 1)
	go func() {
		response, getErr := client.Get("http://" + address + "/in-flight")
		if getErr != nil {
			requestErr <- getErr
			return
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		requestErr <- fmt.Errorf("request completed with status %d after the process exited; the exit path did not abort it", response.StatusCode)
	}()

	inFlightLine, err := reader.ReadString('\n')
	if err != nil {
		_ = command.Wait()
		t.Fatalf("helper never reported the in-flight request (%v); stderr: %s", err, childStderr.String())
	}
	if strings.TrimSpace(inFlightLine) != "in-flight" {
		_ = command.Wait()
		t.Fatalf("helper stdout line = %q, want in-flight", strings.TrimSpace(inFlightLine))
	}

	waitErr := command.Wait()
	var exitError *exec.ExitError
	if !errors.As(waitErr, &exitError) {
		t.Fatalf("helper exit = %v, want exit status 130; stderr: %s", waitErr, childStderr.String())
	}
	if code := exitError.ExitCode(); code != 130 {
		t.Fatalf("helper exit code = %d, want 130; stderr: %s", code, childStderr.String())
	}
	select {
	case err := <-requestErr:
		if err == nil {
			// unreachable, but a nil here would mean the request "completed" silently.
			t.Fatal("the in-flight request reported success after the process exited")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the in-flight request never observed the process exit")
	}
}

// runProcessExitHelper is the child half of TestProcessExitAbortsInFlightRequest.
func runProcessExitHelper() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
	fmt.Fprintln(os.Stdout, listener.Addr().String())
	server := &http.Server{Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		fmt.Fprintln(os.Stdout, "in-flight")
		// The forced-shutdown path: main calls os.Exit(130) while the handler is still running and has
		// written no response. Nothing in this process closes the connection gracefully.
		os.Exit(130)
	})}
	if err := server.Serve(listener); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(4)
	}
}
