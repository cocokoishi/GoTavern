// Command a19-provider is the deterministic, recording OpenAI-compatible provider used by the
// alpha.19 Node-UI-Originated Corpus builder (tests/browser/a19-corpus-builder.mjs).
//
// WHY THIS EXISTS INSTEAD OF tools/mock-provider DIRECTLY. tools/mock-provider serves a POSITIONAL
// response script: request N gets responses[N]. A corpus built by driving a real browser produces an
// unknown, large and interleaved number of requests (the 50-chat / 1000-message matrix alone needs a
// thousand completions, plus whatever the frontend decides to send), and one request the script did
// not anticipate would shift every later answer by one and silently corrupt the corpus replies.
// This command therefore reuses the SAME recorder (`tests/mockprovider`, which parses the request
// from the connection so raw target/header order/body bytes are preserved — the reason it exists)
// through its KEYED mode, and pre-scripts a large number of responses per request shape. It is a
// thin main over that package: it does not re-implement any recording, framing or parsing.
//
// WHAT IT IS NOT. The replies are deterministic markers with varied but fixed text. They define NO
// business semantics: they are not expectations, and nothing in the corpus is compared against them
// as if they were pinned output. A separate control listener exposes the recording for the driver
// (`/__mock/recording`, `/__mock/stats`, `/__mock/unused`, `/__mock/dump`) so a round's capture can
// be written to disk without killing the process.
//
// Usage:
//
//	go run ./tools/a19-corpus/provider --port 0 --control-port 0 --replies 6000 \
//	    --recording-out <path>
//
// The chosen addresses are printed on one line:
//
//	a19-provider recorder=127.0.0.1:P control=127.0.0.1:C
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

// replyTemplates are deterministic, visibly varied assistant replies. The corpus needs variety
// (lengths, CJK, emoji, markdown, escapes) in what a user SEES, not a model that means anything.
// {n} is the reply ordinal, {k} the length class. All non-ASCII text is written as UTF-8 literals
// in this Go source (the file is UTF-8, no BOM).
var replyTemplates = []string{
	"R{n} short reply.",
	"R{n} plain two-line reply.\nSecond line of R{n}.",
	"R{n} 中文回复：星海旅店的门在午夜后仍开着，老板娘记得每一位来客的名字。",
	"R{n} 日本語の返答です。古い図書館の地下に、まだ誰も読んでいない本がある。",
	"R{n} emoji reply 🌙✨🐈‍⬛ and a trailing thought.",
	"R{n} markdown reply.\n\n- item *one*\n- item `two`\n\n> quoted line for R{n}",
	"R{n} long reply. " + strings.Repeat("The lantern lit the courtyard while the rain kept its own slow rhythm. ", 12),
	"R{n} escaped-ish text: quotes \"like this\", backslash \\, braces {curly}, brackets [square].",
	"R{n} mixed 中文 English 日本語 emoji 🧭🎴 and accents café naïve résumé.",
	"R{n} list of names: Alice, 鲍勃, キャロル, Δημήτρης, محمد.",
	"R{n} a medium reply that keeps going for a sentence or two so the chat has body. The clock in the hall disagreed with every guest, and nobody had the heart to fix it.",
	"R{n} 📚 World note: the orchard behind the inn bears fruit only when someone tells the truth. 果园的果子只在有人说真话时结果。",
}

// buildReplies returns the scripted SSE responses for one chat-completion request shape. The
// response is always an SSE stream: the pinned custom OpenAI-compatible source streams by default
// (`oai_settings.stream_openai` defaults true), and a peer that answers JSON to a `stream: true`
// request makes the page store an EMPTY assistant message. The driver records `requestedStream` for
// every request, so a non-streaming request would be visible as a mismatch rather than inferred.
func buildReplies(count int, wire string) []mockprovider.Response {
	replies := make([]mockprovider.Response, 0, count)
	for index := 0; index < count; index++ {
		n := index + 1
		template := replyTemplates[index%len(replyTemplates)]
		text := strings.ReplaceAll(template, "{n}", strconv.Itoa(n))
		// JSON WIRE: used for the corpus message loop. The peer is a deterministic recorder, so the
		// terminal-frame wait of an SSE stream is not part of correctness there; the persisted reply
		// text is. Streaming remains the default (`sse`) and is what the live-oracle journey uses.
		if wire == "json" {
			payload, _ := json.Marshal(map[string]any{
				"id":      fmt.Sprintf("a19-json-%d", n),
				"object":  "chat.completion",
				"created": 1730000000,
				"model":   "a19-deterministic",
				"choices": []any{map[string]any{
					"index":         0,
					"message":       map[string]any{"role": "assistant", "content": text},
					"finish_reason": "stop",
				}},
				"usage": map[string]any{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
			})
			replies = append(replies, mockprovider.Response{
				Status: 200,
				Headers: []mockprovider.Header{
					{Name: "Content-Type", Value: "application/json"},
					{Name: "Access-Control-Allow-Origin", Value: "*"},
				},
				Body: string(payload),
			})
			continue
		}
		content, _ := json.Marshal(map[string]any{
			"id":      fmt.Sprintf("a19-chunk-%d", n),
			"object":  "chat.completion.chunk",
			"created": 1730000000,
			"model":   "a19-deterministic",
			"choices": []any{map[string]any{
				"index":         0,
				"delta":         map[string]any{"role": "assistant", "content": text},
				"finish_reason": nil,
			}},
		})
		stop, _ := json.Marshal(map[string]any{
			"id":      fmt.Sprintf("a19-chunk-%d", n),
			"object":  "chat.completion.chunk",
			"created": 1730000000,
			"model":   "a19-deterministic",
			"choices": []any{map[string]any{
				"index":         0,
				"delta":         map[string]any{},
				"finish_reason": "stop",
			}},
		})
		replies = append(replies, mockprovider.Response{
			Status: 200,
			Headers: []mockprovider.Header{
				{Name: "Content-Type", Value: "text/event-stream"},
				{Name: "Cache-Control", Value: "no-cache"},
				{Name: "Access-Control-Allow-Origin", Value: "*"},
			},
			Stream: []string{
				"data: " + string(content) + "\n\n",
				"data: " + string(stop) + "\n\n",
				"data: [DONE]\n\n",
			},
		})
	}
	return replies
}

func modelsResponse() mockprovider.Response {
	body, _ := json.Marshal(map[string]any{
		"object": "list",
		"data": []any{
			map[string]any{"id": "a19-deterministic", "object": "model"},
		},
	})
	return mockprovider.Response{
		Status:  200,
		Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
		Body:    string(body),
	}
}

func main() {
	port := flag.Int("port", 0, "recorder loopback port; 0 asks the kernel")
	controlPort := flag.Int("control-port", 0, "control loopback port; 0 asks the kernel")
	replies := flag.Int("replies", 6000, "how many scripted chat-completion responses to pre-generate")
	wire := flag.String("wire", "sse", "chat-completion response framing: sse or json (the corpus message loop uses json; the live-oracle journey uses sse)")
	recordingOut := flag.String("recording-out", "", "path written by /__mock/dump and on SIGTERM")
	flag.Parse()

	if *recordingOut == "" {
		fmt.Fprintln(os.Stderr, "a19-provider: --recording-out is required")
		os.Exit(2)
	}

	script := map[string][]mockprovider.Response{
		"GET /v1/models":            repeat(modelsResponse(), 64),
		"GET /models":               repeat(modelsResponse(), 64),
		"POST /v1/chat/completions": buildReplies(*replies, *wire),
	}
	recorder := mockprovider.NewKeyed(script)
	address, err := recorder.Listen(*port)
	if err != nil {
		fmt.Fprintf(os.Stderr, "a19-provider: %v\n", err)
		os.Exit(1)
	}

	control := newControl(recorder, *recordingOut)
	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(*controlPort))
	if err != nil {
		fmt.Fprintf(os.Stderr, "a19-provider: control listener: %v\n", err)
		os.Exit(1)
	}
	server := &http.Server{Handler: control}
	go func() {
		_ = server.Serve(listener)
	}()

	// ONE LINE, so the driver parses addresses instead of guessing them (the same contract
	// tools/mock-provider already uses for its single address).
	fmt.Printf("a19-provider recorder=%s control=%s\n", address.String(), listener.Addr().String())
	os.Stdout.Sync()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	if err := control.dump(); err != nil {
		fmt.Fprintf(os.Stderr, "a19-provider: dump on shutdown: %v\n", err)
	}
	_ = server.Close()
	_ = recorder.Close()
}

func repeat(response mockprovider.Response, count int) []mockprovider.Response {
	out := make([]mockprovider.Response, count)
	for index := range out {
		out[index] = response
	}
	return out
}
