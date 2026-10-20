package mockprovider

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// controlPrefix marks the harness control endpoints. Traffic under it is
// answered but never recorded, so control traffic cannot be mistaken for
// provider traffic.
const controlPrefix = "/__mock/"

// Header is one received header. Name casing and arrival order are preserved
// verbatim: the recorder parses the request itself rather than going through
// net/http, whose header map canonicalises names and loses both. A provider
// sees the bytes on the wire, so the capture must too.
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Request is one provider request exactly as it arrived.
type Request struct {
	// Index is the arrival position, which selects the scripted response. It
	// comes from arrival order, never from a clock or a random value.
	Index      int      `json:"index"`
	Method     string   `json:"method"`
	RawTarget  string   `json:"rawTarget"`
	RawPath    string   `json:"rawPath"`
	RawQuery   string   `json:"rawQuery"`
	Proto      string   `json:"proto"`
	Headers    []Header `json:"headers"`
	BodyText   *string  `json:"bodyText"`
	BodyBase64 string   `json:"bodyBase64"`
	BodyLength int      `json:"bodyLength"`
	BodySHA256 string   `json:"bodySha256"`
	// Chunked reports whether the caller framed the body with chunked transfer
	// encoding, which is itself observable at the provider.
	Chunked bool `json:"chunked"`
	// ClientDisconnected reports whether the caller went away before the
	// response finished; this is how cancellation is observed.
	ClientDisconnected bool `json:"clientDisconnected"`
}

// Response is one scripted reply. Body, Stream and NeverEnds are mutually
// exclusive descriptions of the body. TruncateAfterFrames aborts a stream
// without a terminal sentinel, which models a provider that dies mid-stream.
type Response struct {
	Status              int      `json:"status"`
	Headers             []Header `json:"headers"`
	Body                string   `json:"body"`
	Stream              []string `json:"stream"`
	TruncateAfterFrames bool     `json:"truncateAfterFrames"`
	NeverEnds           bool     `json:"neverEnds"`
}

// Recording is the capture a differential probe compares.
type Recording struct {
	Requests []Request `json:"requests"`
}

// Recorder serves a fixed response script and records what it received.
type Recorder struct {
	mu        sync.Mutex
	responses []Response
	requests  []Request
	next      int
	listener  net.Listener
	closed    chan struct{}
}

// New returns a recorder that answers the nth request with responses[n]. A
// request beyond the script is answered with 500 and an explanatory body, so a
// scenario that sends more requests than it scripted fails loudly instead of
// silently reusing an earlier reply.
func New(responses []Response) *Recorder {
	return &Recorder{
		responses: append([]Response(nil), responses...),
		closed:    make(chan struct{}),
	}
}

// Recording returns a copy of everything received so far.
func (recorder *Recorder) Recording() Recording {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	requests := make([]Request, len(recorder.requests))
	copy(requests, recorder.requests)
	return Recording{Requests: requests}
}

// Reset clears the recording and restarts the script.
func (recorder *Recorder) Reset() {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.requests = nil
	recorder.next = 0
}

// Listen starts the recorder on a loopback port and returns the address so a
// backend can be pointed at it. Port 0 asks the kernel for a free port; the
// port is ephemeral but the capture normalises the authority, so the choice
// never leaks into a comparison.
func (recorder *Recorder) Listen(port int) (net.Addr, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return nil, fmt.Errorf("listen for mock provider: %w", err)
	}
	recorder.mu.Lock()
	recorder.listener = listener
	recorder.mu.Unlock()
	go recorder.acceptLoop(listener)
	return listener.Addr(), nil
}

// Close stops accepting new connections.
func (recorder *Recorder) Close() error {
	recorder.mu.Lock()
	listener := recorder.listener
	recorder.listener = nil
	recorder.mu.Unlock()
	select {
	case <-recorder.closed:
	default:
		close(recorder.closed)
	}
	if listener == nil {
		return nil
	}
	return listener.Close()
}

func (recorder *Recorder) acceptLoop(listener net.Listener) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		go recorder.handleConnection(connection)
	}
}

// handleConnection serves requests sequentially on one connection so keep-alive
// works, and stops as soon as the peer closes.
func (recorder *Recorder) handleConnection(connection net.Conn) {
	defer connection.Close()
	reader := bufio.NewReader(connection)
	for {
		request, err := readRequest(reader)
		if err != nil {
			return
		}
		if strings.HasPrefix(request.RawPath, controlPrefix) {
			if !recorder.serveControl(connection, request) {
				return
			}
			continue
		}
		keepAlive := recorder.serveProvider(connection, reader, request)
		if !keepAlive {
			return
		}
	}
}

// serveControl answers the harness control endpoints. Control traffic is never
// recorded, so it cannot be mistaken for provider traffic.
func (recorder *Recorder) serveControl(connection net.Conn, request *rawRequest) bool {
	switch request.RawPath {
	case controlPrefix + "recording":
		payload, err := json.Marshal(recorder.Recording())
		if err != nil {
			writeSimpleResponse(connection, 500, "text/plain; charset=utf-8", []byte("could not encode recording"))
			return false
		}
		writeSimpleResponse(connection, 200, "application/json", payload)
	case controlPrefix + "reset":
		recorder.Reset()
		writeSimpleResponse(connection, 204, "", nil)
	default:
		writeSimpleResponse(connection, 404, "text/plain; charset=utf-8", []byte("unknown control endpoint"))
	}
	return false
}

// serveProvider records the request, replays the scripted response, and reports
// whether the connection may be reused.
func (recorder *Recorder) serveProvider(connection net.Conn, reader *bufio.Reader, request *rawRequest) bool {
	recorded := describe(request)
	recorder.mu.Lock()
	recorded.Index = recorder.next
	script := Response{Status: 500, Body: "mock provider has no scripted response for this request"}
	if recorder.next < len(recorder.responses) {
		script = recorder.responses[recorder.next]
	}
	recorder.next++
	position := len(recorder.requests)
	recorder.requests = append(recorder.requests, recorded)
	recorder.mu.Unlock()

	if script.NeverEnds {
		// Hold the response open until the caller goes away. No clock is
		// involved: the handler waits for the peer to close. The body is
		// chunk-framed so the caller cannot mistake it for a finished response.
		writeResponseHead(connection, script, -1)
		writeChunk(connection, "data: {\"held\":true}\n\n")
		_, _ = io.Copy(io.Discard, reader)
		recorder.markDisconnected(position)
		return false
	}

	if len(script.Stream) > 0 {
		writeResponseHead(connection, script, -1)
		for _, frame := range script.Stream {
			if !writeChunk(connection, frame) {
				recorder.markDisconnected(position)
				return false
			}
		}
		if script.TruncateAfterFrames {
			// Drop the connection without the terminating zero-length chunk or
			// any terminal sentinel, so the caller sees a truncated stream.
			return false
		}
		_, _ = io.WriteString(connection, "0\r\n\r\n")
		return requestKeepAlive(request)
	}

	writeResponseHead(connection, script, len(script.Body))
	if script.Body != "" {
		if _, err := io.WriteString(connection, script.Body); err != nil {
			recorder.markDisconnected(position)
			return false
		}
	}
	return requestKeepAlive(request)
}

func (recorder *Recorder) markDisconnected(position int) {
	recorder.mu.Lock()
	if position < len(recorder.requests) {
		recorder.requests[position].ClientDisconnected = true
	}
	recorder.mu.Unlock()
}

// writeResponseHead writes the status line and headers. bodyLength < 0 means the
// body is streamed with chunked framing, 0 means an empty body, and a positive
// value declares that length.
func writeResponseHead(connection net.Conn, script Response, bodyLength int) {
	status := script.Status
	if status == 0 {
		status = 200
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "HTTP/1.1 %d %s\r\n", status, statusText(status))
	declared := map[string]bool{}
	for _, header := range script.Headers {
		fmt.Fprintf(&builder, "%s: %s\r\n", header.Name, header.Value)
		declared[strings.ToLower(header.Name)] = true
	}
	switch {
	case declared["content-length"] || declared["transfer-encoding"]:
		// The script controls framing explicitly.
	case bodyLength < 0:
		builder.WriteString("Transfer-Encoding: chunked\r\n")
	case bodyLength > 0:
		fmt.Fprintf(&builder, "Content-Length: %d\r\n", bodyLength)
	default:
		builder.WriteString("Content-Length: 0\r\n")
	}
	builder.WriteString("\r\n")
	_, _ = io.WriteString(connection, builder.String())
}

// writeChunk writes one chunked-transfer frame and reports whether it reached
// the peer.
func writeChunk(connection net.Conn, frame string) bool {
	if _, err := fmt.Fprintf(connection, "%x\r\n%s\r\n", len(frame), frame); err != nil {
		return false
	}
	return true
}

func writeSimpleResponse(connection net.Conn, status int, contentType string, body []byte) {
	var builder strings.Builder
	fmt.Fprintf(&builder, "HTTP/1.1 %d %s\r\n", status, statusText(status))
	if contentType != "" {
		fmt.Fprintf(&builder, "Content-Type: %s\r\n", contentType)
	}
	fmt.Fprintf(&builder, "Content-Length: %d\r\n\r\n", len(body))
	_, _ = io.WriteString(connection, builder.String())
	if len(body) > 0 {
		_, _ = connection.Write(body)
	}
}

func requestKeepAlive(request *rawRequest) bool {
	for _, header := range request.Headers {
		if strings.EqualFold(header.Name, "connection") {
			return !strings.EqualFold(strings.TrimSpace(header.Value), "close")
		}
	}
	return request.Proto == "HTTP/1.1"
}

// rawRequest is the request exactly as it arrived, before any interpretation.
type rawRequest struct {
	Method    string
	RawTarget string
	RawPath   string
	RawQuery  string
	Proto     string
	Headers   []Header
	Body      []byte
	Chunked   bool
}

func readRequest(reader *bufio.Reader) (*rawRequest, error) {
	line, err := readLine(reader)
	if err != nil {
		return nil, err
	}
	parts := strings.SplitN(line, " ", 3)
	if len(parts) != 3 {
		return nil, errors.New("malformed request line")
	}
	request := &rawRequest{Method: parts[0], RawTarget: parts[1], Proto: parts[2]}
	if index := strings.IndexByte(request.RawTarget, '?'); index >= 0 {
		request.RawPath = request.RawTarget[:index]
		request.RawQuery = request.RawTarget[index+1:]
	} else {
		request.RawPath = request.RawTarget
	}
	for {
		headerLine, err := readLine(reader)
		if err != nil {
			return nil, err
		}
		if headerLine == "" {
			break
		}
		separator := strings.IndexByte(headerLine, ':')
		if separator < 0 {
			return nil, errors.New("malformed header line")
		}
		request.Headers = append(request.Headers, Header{
			Name:  headerLine[:separator],
			Value: strings.TrimLeft(headerLine[separator+1:], " \t"),
		})
	}
	chunked := false
	contentLength := -1
	for _, header := range request.Headers {
		switch {
		case strings.EqualFold(header.Name, "content-length"):
			parsed, parseErr := strconv.Atoi(strings.TrimSpace(header.Value))
			if parseErr != nil {
				return nil, fmt.Errorf("malformed content-length: %w", parseErr)
			}
			contentLength = parsed
		case strings.EqualFold(header.Name, "transfer-encoding") && strings.Contains(strings.ToLower(header.Value), "chunked"):
			chunked = true
		}
	}
	request.Chunked = chunked
	switch {
	case chunked:
		body, readErr := readChunkedBody(reader)
		if readErr != nil {
			return nil, readErr
		}
		request.Body = body
	case contentLength > 0:
		body := make([]byte, contentLength)
		if _, readErr := io.ReadFull(reader, body); readErr != nil {
			return nil, readErr
		}
		request.Body = body
	}
	return request, nil
}

// readChunkedBody reads a chunked body and returns the decoded bytes, which are
// what the provider would parse; the chunk framing itself is recorded as a
// boolean because it is observable but not part of the payload.
func readChunkedBody(reader *bufio.Reader) ([]byte, error) {
	var body []byte
	for {
		sizeLine, err := readLine(reader)
		if err != nil {
			return nil, err
		}
		if index := strings.IndexByte(sizeLine, ';'); index >= 0 {
			sizeLine = sizeLine[:index]
		}
		size, err := strconv.ParseInt(strings.TrimSpace(sizeLine), 16, 64)
		if err != nil {
			return nil, fmt.Errorf("malformed chunk size: %w", err)
		}
		if size == 0 {
			for {
				trailer, err := readLine(reader)
				if err != nil {
					return nil, err
				}
				if trailer == "" {
					return body, nil
				}
			}
		}
		chunk := make([]byte, size)
		if _, err := io.ReadFull(reader, chunk); err != nil {
			return nil, err
		}
		body = append(body, chunk...)
		if _, err := readLine(reader); err != nil {
			return nil, err
		}
	}
}

// readLine reads one CRLF-terminated line and returns it without the CRLF,
// preserving everything else byte for byte.
func readLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	line = strings.TrimSuffix(line, "\n")
	return strings.TrimSuffix(line, "\r"), nil
}

// describe captures the request exactly as received.
func describe(request *rawRequest) Request {
	digest := sha256.Sum256(request.Body)
	headers := make([]Header, len(request.Headers))
	copy(headers, request.Headers)
	recorded := Request{
		Method:     request.Method,
		RawTarget:  request.RawTarget,
		RawPath:    request.RawPath,
		RawQuery:   request.RawQuery,
		Proto:      request.Proto,
		Headers:    headers,
		BodyBase64: base64.StdEncoding.EncodeToString(request.Body),
		BodyLength: len(request.Body),
		BodySHA256: hex.EncodeToString(digest[:]),
		Chunked:    request.Chunked,
	}
	if utf8.Valid(request.Body) {
		text := string(request.Body)
		recorded.BodyText = &text
	}
	return recorded
}

func statusText(status int) string {
	if text, ok := statusTexts[status]; ok {
		return text
	}
	return "Status"
}

var statusTexts = map[int]string{
	200: "OK",
	201: "Created",
	204: "No Content",
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	429: "Too Many Requests",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
}
