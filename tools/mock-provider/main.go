// Command mock-provider runs the recording mock provider used by provider-wire
// differential capture. It is test infrastructure: it is never part of a
// GoTavern release, and nothing under internal/ or cmd/ imports it.
//
// Usage:
//
//	go run ./tools/mock-provider --responses script.json [--port 0]
//
// The chosen address is printed to stdout as "mock-provider <host:port>" so a
// caller can point a backend at it, and the recording can be read at any time
// from GET /__mock/recording or written with --recording-out on shutdown.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

func main() {
	responsesPath := flag.String("responses", "", "JSON file containing the response script")
	port := flag.Int("port", 0, "loopback port to listen on; 0 asks the kernel for a free one")
	recordingOut := flag.String("recording-out", "", "optional path to write the recording to on shutdown")
	flag.Parse()

	if *responsesPath == "" {
		fmt.Fprintln(os.Stderr, "usage: mock-provider --responses <script.json> [--port 0] [--recording-out <path>]")
		os.Exit(2)
	}
	scriptBytes, err := os.ReadFile(*responsesPath)
	if err != nil {
		fatal(fmt.Errorf("read response script: %w", err))
	}
	// Tolerate a UTF-8 BOM: scenario files may be hand-edited on Windows, and a
	// BOM is not part of the JSON the author wrote.
	scriptBytes = bytes.TrimPrefix(scriptBytes, []byte{0xEF, 0xBB, 0xBF})
	var script struct {
		Responses []mockprovider.Response `json:"responses"`
	}
	if err := json.Unmarshal(scriptBytes, &script); err != nil {
		fatal(fmt.Errorf("parse response script: %w", err))
	}

	recorder := mockprovider.New(script.Responses)
	address, err := recorder.Listen(*port)
	if err != nil {
		fatal(err)
	}
	// Print the address on one line so a caller can parse it without guessing.
	fmt.Printf("mock-provider %s\n", address.String())
	if listener, ok := address.(*net.TCPAddr); ok {
		_ = listener
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	if *recordingOut != "" {
		recording := recorder.Recording()
		encoded, err := json.MarshalIndent(recording, "", "  ")
		if err != nil {
			fatal(fmt.Errorf("encode recording: %w", err))
		}
		if err := os.WriteFile(*recordingOut, append(encoded, '\n'), 0o600); err != nil {
			fatal(fmt.Errorf("write recording: %w", err))
		}
	}
	_ = recorder.Close()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
