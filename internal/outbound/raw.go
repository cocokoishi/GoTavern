// Package outbound sends provider requests in the exact wire form the pinned
// backend uses.
//
// Go's net/http cannot express that form: it canonicalises header names and
// emits them in its own order, while pinned SillyTavern sends node-fetch's
// lowercase names in a specific order with Host and Connection appended last.
// The provider observes the bytes, so this package writes the request itself.
//
// The wire form is not derived from reading the pinned source. It is the
// captured contract in tests/oracle/sillytavern-1.19.0-provider-wire.json,
// which records what actually reached a recording provider.
package outbound

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Header is one request or response header. Name casing and order are preserved
// because the provider observes them.
type Header struct {
	Name  string
	Value string
}

// Request is one provider request exactly as it must appear on the wire.
type Request struct {
	URL     string
	Method  string
	Headers []Header
	Body    []byte
}

// Response is the provider's reply. Body is fully read for non-streaming calls;
// Stream is populated instead when StreamBody is requested.
type Response struct {
	Status  int
	Reason  string
	Headers []Header
	Body    []byte
	Stream  io.ReadCloser

	// Truncated reports that the body ended before its own framing completed:
	// a chunked body that stopped without the terminal zero-length chunk, or a
	// Content-Length body that stopped short of its declared length. It is the
	// difference between a provider that finished and one that died mid-reply,
	// which a caller cannot recover from the bytes alone because both look like
	// an end of stream. Pinned node-fetch surfaces the same distinction as an
	// error on the response body stream.
	Truncated bool
}

// Header returns the first value for a header name, case-insensitively.
func (response *Response) Header(name string) string {
	for _, header := range response.Headers {
		if strings.EqualFold(header.Name, name) {
			return header.Value
		}
	}
	return ""
}

// Send writes the request verbatim and reads the whole response body.
func Send(ctx context.Context, request Request, timeout time.Duration) (*Response, error) {
	response, err := SendStreaming(ctx, request, timeout)
	if err != nil {
		return nil, err
	}
	defer response.Stream.Close()
	body, err := io.ReadAll(response.Stream)
	if err != nil {
		return nil, fmt.Errorf("read provider response body: %w", err)
	}
	response.Body = body
	return response, nil
}

// SendStreaming writes the request verbatim and returns the response with its
// body still streaming, so a caller can forward frames as they arrive.
func SendStreaming(ctx context.Context, request Request, timeout time.Duration) (*Response, error) {
	parsed, err := url.Parse(request.URL)
	if err != nil {
		return nil, fmt.Errorf("parse provider url: %w", err)
	}
	host := parsed.Host
	if parsed.Port() == "" {
		if parsed.Scheme == "https" {
			host = net.JoinHostPort(parsed.Hostname(), "443")
		} else {
			host = net.JoinHostPort(parsed.Hostname(), "80")
		}
	}
	dialer := &net.Dialer{Timeout: timeout}
	connection, err := dialer.DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, fmt.Errorf("connect to provider: %w", err)
	}

	// Request target is the raw path exactly as constructed, so a doubled slash
	// survives: the pinned backend appends '/chat/completions' to a URL that
	// already ends in '/', and the provider sees '//chat/completions'.
	target := parsed.EscapedPath()
	if target == "" {
		target = "/"
	}
	if parsed.RawQuery != "" {
		target += "?" + parsed.RawQuery
	}

	var head bytes.Buffer
	fmt.Fprintf(&head, "%s %s HTTP/1.1\r\n", request.Method, target)
	for _, header := range request.Headers {
		fmt.Fprintf(&head, "%s: %s\r\n", header.Name, header.Value)
	}
	head.WriteString("\r\n")
	if _, err := connection.Write(head.Bytes()); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("write provider request head: %w", err)
	}
	if len(request.Body) > 0 {
		if _, err := connection.Write(request.Body); err != nil {
			_ = connection.Close()
			return nil, fmt.Errorf("write provider request body: %w", err)
		}
	}

	// A deadline bounds the read, but cancellation must also close the
	// connection so a provider that never finishes cannot pin the goroutine.
	if timeout > 0 {
		_ = connection.SetDeadline(time.Now().Add(timeout))
	}
	go func() {
		<-ctx.Done()
		_ = connection.Close()
	}()

	reader := bufio.NewReader(connection)
	response, err := readResponseHead(reader)
	if err != nil {
		_ = connection.Close()
		return nil, err
	}
	response.Stream = newBodyReader(reader, connection, response)
	return response, nil
}

func readResponseHead(reader *bufio.Reader) (*Response, error) {
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		return nil, fmt.Errorf("read provider status line: %w", err)
	}
	statusLine = strings.TrimRight(statusLine, "\r\n")
	parts := strings.SplitN(statusLine, " ", 3)
	if len(parts) < 2 {
		return nil, fmt.Errorf("malformed provider status line %q", statusLine)
	}
	status, err := strconv.Atoi(parts[1])
	if err != nil {
		return nil, fmt.Errorf("malformed provider status %q", parts[1])
	}
	response := &Response{Status: status}
	if len(parts) == 3 {
		response.Reason = parts[2]
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, fmt.Errorf("read provider header: %w", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		separator := strings.IndexByte(line, ':')
		if separator < 0 {
			return nil, fmt.Errorf("malformed provider header %q", line)
		}
		response.Headers = append(response.Headers, Header{
			Name:  line[:separator],
			Value: strings.TrimLeft(line[separator+1:], " \t"),
		})
	}
	return response, nil
}

// bodyReader frames a response body by Content-Length, chunked transfer
// encoding, or connection close, which are the three framings a provider may
// use.
type bodyReader struct {
	reader     *bufio.Reader
	connection net.Conn
	response   *Response
	remaining  int64
	hasLength  bool
	chunked    bool
	done       bool
}

func newBodyReader(reader *bufio.Reader, connection net.Conn, response *Response) *bodyReader {
	body := &bodyReader{reader: reader, connection: connection, response: response}
	if length := response.Header("Content-Length"); length != "" {
		if parsed, err := strconv.ParseInt(strings.TrimSpace(length), 10, 64); err == nil && parsed >= 0 {
			body.remaining = parsed
			body.hasLength = true
		}
	}
	if strings.Contains(strings.ToLower(response.Header("Transfer-Encoding")), "chunked") {
		body.chunked = true
	}
	return body
}

func (body *bodyReader) Read(target []byte) (int, error) {
	if body.done {
		return 0, io.EOF
	}
	if body.chunked {
		return body.readChunked(target)
	}
	if body.hasLength {
		if body.remaining == 0 {
			body.done = true
			return 0, io.EOF
		}
		if int64(len(target)) > body.remaining {
			target = target[:body.remaining]
		}
		count, err := body.reader.Read(target)
		body.remaining -= int64(count)
		if body.remaining == 0 && err == nil {
			body.done = true
		}
		if body.remaining > 0 && err != nil {
			// The provider declared more bytes than it sent: the reply was cut
			// off rather than finished.
			body.response.Truncated = true
			body.done = true
		}
		return count, err
	}
	// No declared length: the body ends when the provider closes the connection,
	// which is a legitimate end for a connection-close framed reply. Only an
	// abnormal read error is a truncation.
	count, err := body.reader.Read(target)
	if errors.Is(err, io.EOF) {
		body.done = true
	} else if err != nil {
		body.response.Truncated = true
		body.done = true
	}
	return count, err
}

func (body *bodyReader) readChunked(target []byte) (int, error) {
	if body.remaining == 0 {
		sizeLine, err := body.reader.ReadString('\n')
		if err != nil {
			// A chunk header (or the terminal zero-length chunk) was expected,
			// so the provider stopped mid-frame.
			body.response.Truncated = true
			body.done = true
			return 0, err
		}
		sizeLine = strings.TrimSpace(sizeLine)
		if index := strings.IndexByte(sizeLine, ';'); index >= 0 {
			sizeLine = sizeLine[:index]
		}
		size, err := strconv.ParseInt(sizeLine, 16, 64)
		if err != nil {
			body.response.Truncated = true
			body.done = true
			return 0, fmt.Errorf("malformed provider chunk size %q", sizeLine)
		}
		if size == 0 {
			body.done = true
			return 0, io.EOF
		}
		body.remaining = size
	}
	if int64(len(target)) > body.remaining {
		target = target[:body.remaining]
	}
	count, err := body.reader.Read(target)
	body.remaining -= int64(count)
	if body.remaining > 0 && err != nil {
		body.response.Truncated = true
		body.done = true
		return count, err
	}
	if body.remaining == 0 {
		// Consume the CRLF that terminates the chunk.
		if _, err := body.reader.ReadString('\n'); err != nil {
			body.response.Truncated = true
			body.done = true
			if errors.Is(err, io.EOF) {
				return count, nil
			}
			return count, err
		}
	}
	return count, err
}

func (body *bodyReader) Close() error {
	body.done = true
	return body.connection.Close()
}
