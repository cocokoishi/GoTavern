package mockprovider

// KeyedRecorder is a recording peer whose script is selected by "METHOD path" instead of arrival
// order. The SD domain needs it for two reasons the sequential Recorder cannot express:
//
//   - one route fetches two different paths CONCURRENTLY (/api/sd/upscalers), so arrival order is
//     not deterministic and a positional script would race;
//   - one route talks to a peer whose answer depends on which of several endpoints was called,
//     including redirect hops.
//
// It records exactly what the sequential Recorder records (raw target, header lines in wire order,
// body) by sharing readRequest/describe/writeScriptedResponse, so a capture from either recorder is
// comparable.

import (
	"bufio"
	"fmt"
	"net"
	"strconv"
	"sync"
)

// KeyedRecorder serves scripted responses selected by request method and path.
type KeyedRecorder struct {
	mu       sync.Mutex
	script   map[string][]Response
	used     map[string]int
	requests []Request
	listener net.Listener
}

// NewKeyed returns a recorder that answers the next unused response for "METHOD path". A request
// with no remaining scripted response is answered with 500 and an explanatory body, so a scenario
// that makes more requests than it declared fails loudly.
func NewKeyed(script map[string][]Response) *KeyedRecorder {
	recorder := &KeyedRecorder{}
	recorder.Reset(script)
	return recorder
}

// Reset replaces the script and clears the recording.
func (recorder *KeyedRecorder) Reset(script map[string][]Response) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.script = map[string][]Response{}
	for key, responses := range script {
		recorder.script[key] = append([]Response(nil), responses...)
	}
	recorder.used = map[string]int{}
	recorder.requests = nil
}

// Recording returns a copy of everything received so far.
func (recorder *KeyedRecorder) Recording() Recording {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	requests := make([]Request, len(recorder.requests))
	copy(requests, recorder.requests)
	return Recording{Requests: requests}
}

// Unused returns the script keys that were never requested, so a test can prove its scenario
// reached every peer endpoint it declared.
func (recorder *KeyedRecorder) Unused() []string {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	unused := make([]string, 0)
	for key, responses := range recorder.script {
		if recorder.used[key] < len(responses) {
			unused = append(unused, key)
		}
	}
	return unused
}

// Listen starts the recorder on a loopback port and returns its address.
func (recorder *KeyedRecorder) Listen(port int) (net.Addr, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return nil, fmt.Errorf("listen for keyed mock provider: %w", err)
	}
	recorder.mu.Lock()
	recorder.listener = listener
	recorder.mu.Unlock()
	go recorder.acceptLoop(listener)
	return listener.Addr(), nil
}

// Close stops accepting new connections.
func (recorder *KeyedRecorder) Close() error {
	recorder.mu.Lock()
	listener := recorder.listener
	recorder.listener = nil
	recorder.mu.Unlock()
	if listener == nil {
		return nil
	}
	return listener.Close()
}

func (recorder *KeyedRecorder) acceptLoop(listener net.Listener) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		go recorder.handleConnection(connection)
	}
}

func (recorder *KeyedRecorder) handleConnection(connection net.Conn) {
	defer connection.Close()
	reader := bufio.NewReader(connection)
	for {
		request, err := readRequest(reader)
		if err != nil {
			return
		}
		key := request.Method + " " + request.RawPath
		recorded := describe(request)
		recorder.mu.Lock()
		recorded.Index = len(recorder.requests)
		script := Response{Status: 500, Body: "keyed mock peer has no scripted response for " + key}
		if responses := recorder.script[key]; recorder.used[key] < len(responses) {
			script = responses[recorder.used[key]]
		}
		recorder.used[key]++
		recorder.requests = append(recorder.requests, recorded)
		recorder.mu.Unlock()

		keepAlive, _ := writeScriptedResponse(connection, reader, request, script)
		if !keepAlive {
			return
		}
	}
}
