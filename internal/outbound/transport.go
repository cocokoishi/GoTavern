package outbound

// THE PRODUCTION TRANSPORT.
//
// `raw.go` writes HTTP/1.1 by hand so the provider-wire oracle can observe pinned's exact request
// bytes, and it is the only client that can. It is a measuring instrument: no proxy support, no
// redirects, no connection reuse, no response decoding and no bound on a provider that accepts TCP
// and then stalls. Those are not defects in it; they are why it must not carry user traffic
// (ARCHITECTURE.md 34.1, AGENTS.md rules 29-30).
//
// This file is the client that carries user traffic: net/http, with everything the real internet
// requires and a local mock cannot exercise — system roots, environment proxies, keep-alive,
// redirects, decompression and cancellation.
//
// WHAT DELIBERATELY DIFFERS FROM THE CAPTURES (rule 30 sanctions exactly this):
//   - `Connection: keep-alive` where the captures record `close`. Reuse is a requirement (rule 29);
//     the captured value is node-fetch's, and reproducing it would defeat reuse.
//   - `Accept-Encoding: gzip` instead of `gzip, deflate, br`. We have no brotli decoder and cannot add
//     one here (go.mod has no such module and this host cannot produce a go.sum), so the production
//     client advertises only what it decodes; net/http then adds gzip itself and decompresses it
//     transparently. An encoding nobody asked for becomes a CAUSAL error instead of bytes that fail
//     to parse.
//   - Header casing and order, because net/http canonicalises them.
// The wire-exact client is used only when GOTAVERN_OUTBOUND_WIRE_EXACT=1 is present in the process
// environment at the first provider call. The provider-wire replay sets it; nothing else does, and no
// production request can be diverted to it by anything a test does at runtime.

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Bounds. Each exists so a misbehaving provider fails with a NAME rather than parking a request
// forever. There is deliberately no bound on the body: a streaming completion may legitimately run
// for minutes, so its duration is governed by the caller's context, never by a clock — a clock would
// truncate a legitimate long reply, which is the mirror of the stall it would be "fixing".
const (
	productionConnectTimeout        = 30 * time.Second
	productionTLSHandshakeTimeout   = 15 * time.Second
	productionResponseHeaderTimeout = 120 * time.Second
	productionIdleConnTimeout       = 90 * time.Second
	productionMaxIdleConnections    = 32
)

var (
	wireExactOnce sync.Once
	wireExactMode bool

	// Clients are shared so that keep-alive works (D5). The key is the caller's TLS configuration:
	// production passes nil and gets the one shared client; a test that trusts a local certificate
	// passes its own pointer and gets a client of its own, so two requests with the SAME configuration
	// still reuse a connection while a per-request configuration cannot mutate state another request
	// observes. Nothing here selects a transport -- that is the seam's job, and this is not it.
	clientsMu sync.Mutex
	clients   = map[*tls.Config]*http.Client{}
)

// TransportMode reports which client carries this process's provider traffic, so that a test can
// assert the seam actually took effect. Without that assertion GOTAVERN_OUTBOUND_WIRE_EXACT could be
// ignored entirely and the provider-wire replay would stay green while measuring the wrong client.
func TransportMode() string {
	wireExactOnce.Do(func() {
		wireExactMode = os.Getenv("GOTAVERN_OUTBOUND_WIRE_EXACT") == "1"
	})
	if wireExactMode {
		return "wire-exact"
	}
	return "production"
}

func wireExactEnabled() bool { return TransportMode() == "wire-exact" }

// Send performs one provider request and reads the whole reply.
func Send(ctx context.Context, request Request, timeout time.Duration) (*Response, error) {
	if wireExactEnabled() {
		return sendWireExact(ctx, request, timeout)
	}
	response, err := SendStreaming(ctx, request, timeout)
	if err != nil {
		return nil, err
	}
	defer response.Stream.Close()
	body, readErr := io.ReadAll(response.Stream)
	if readErr != nil {
		return nil, readErr
	}
	response.Body = body
	return response, nil
}

// SendStreaming performs one provider request and returns the reply with its body still streaming.
func SendStreaming(ctx context.Context, request Request, timeout time.Duration) (*Response, error) {
	if wireExactEnabled() {
		return sendWireExactStreaming(ctx, request, timeout)
	}
	return sendProductionStreaming(ctx, request, timeout)
}

func transportFor(config *tls.Config) *http.Client {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	if existing, ok := clients[config]; ok {
		return existing
	}
	client := buildProductionClient(config)
	clients[config] = client
	return client
}

func buildProductionClient(config *tls.Config) *http.Client {
	transport := &http.Transport{
		// THE USER'S CONFIGURED PROXY FIRST, THEN THE ENVIRONMENT.
		//
		// D3 was "no proxy support anywhere", and it had two halves. The environment half is net/http's
		// job; the other half is pinned's own requestProxy.enabled/url/bypass, which
		// internal/commandline/options.go:231-233 parses into ServerOptions and, until now, NOTHING read
		// -- so the documented way for a user behind a proxy to reach a provider did nothing at all.
		// providerProxy decides per request from the value ConfigureRequestProxy stored, so a setting
		// applied late still takes effect instead of being baked into a cached client.
		Proxy: providerProxy,
		DialContext: (&net.Dialer{
			Timeout:   productionConnectTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   productionTLSHandshakeTimeout,
		ResponseHeaderTimeout: productionResponseHeaderTimeout,
		IdleConnTimeout:       productionIdleConnTimeout,
		MaxIdleConns:          productionMaxIdleConnections,
		MaxIdleConnsPerHost:   productionMaxIdleConnections,
		DisableKeepAlives:     false,
		// We never set Accept-Encoding, so net/http advertises gzip and decodes it transparently.
		DisableCompression: false,
		ForceAttemptHTTP2:  true,
		TLSClientConfig:    config,
	}
	return &http.Client{
		Transport: transport,
		// A bounded redirect policy rather than an open-ended one: an edge that redirects twice is
		// ordinary, one that redirects in a loop must fail by name.
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("provider redirected %d times; giving up", len(via))
			}
			return nil
		},
	}
}

func sendProductionStreaming(ctx context.Context, request Request, timeout time.Duration) (*Response, error) {
	host := providerHost(request.URL)

	callContext := ctx
	var cancel context.CancelFunc
	if timeout > 0 {
		// The caller asked for a whole-exchange bound; that is the pre-existing meaning of this
		// argument and the one caller that passes a value keeps it.
		callContext, cancel = context.WithTimeout(ctx, timeout)
	}

	httpRequest, err := http.NewRequestWithContext(callContext, request.Method, request.URL, bytes.NewReader(request.Body))
	if err != nil {
		if cancel != nil {
			cancel()
		}
		return nil, fmt.Errorf("build request for provider %s: %w", host, err)
	}
	for _, header := range request.Headers {
		if isTransportOwnedHeader(header.Name) {
			continue
		}
		httpRequest.Header.Set(header.Name, header.Value)
	}

	reply, err := transportFor(request.TLSConfig).Do(httpRequest)
	if err != nil {
		if cancel != nil {
			cancel()
		}
		return nil, explainTransportError(err, host)
	}

	result := &Response{Status: reply.StatusCode, Reason: responseReason(reply.Status)}
	for name, values := range reply.Header {
		for _, value := range values {
			result.Headers = append(result.Headers, Header{Name: name, Value: value})
		}
	}

	body, decodeErr := decodeProviderBody(reply, host)
	if decodeErr != nil {
		_ = reply.Body.Close()
		if cancel != nil {
			cancel()
		}
		return nil, decodeErr
	}
	result.Stream = &attributedBody{response: result, host: host, body: body, cancel: cancel}
	return result, nil
}

// decodeProviderBody returns the bytes the caller should see, or a causal error. net/http has already
// decompressed and removed the header when it advertised gzip itself, so anything still labelled here
// is an encoding we did not request or cannot read.
func decodeProviderBody(reply *http.Response, host string) (io.ReadCloser, error) {
	encoding := strings.ToLower(strings.TrimSpace(reply.Header.Get("Content-Encoding")))
	switch encoding {
	case "", "identity":
		return reply.Body, nil
	case "gzip":
		reader, err := gzip.NewReader(reply.Body)
		if err != nil {
			return nil, fmt.Errorf("provider %s answered content-encoding gzip but the body is not gzip: %w", host, err)
		}
		return reader, nil
	case "deflate", "x-deflate":
		// `deflate` is ambiguous in the wild: some servers send zlib-wrapped data, some raw deflate.
		if reader, err := zlib.NewReader(reply.Body); err == nil {
			return reader, nil
		}
		return flate.NewReader(reply.Body), nil
	default:
		return nil, fmt.Errorf("provider %s answered with unsupported content-encoding %q: this client advertises only gzip, so the reply cannot be decoded", host, encoding)
	}
}

// attributedBody names the host when a reply dies mid-stream. Without it the caller sees a bare
// "unexpected EOF" and cannot tell which provider died — the same class of defect as the original
// "cannot connect".
type attributedBody struct {
	response *Response
	host     string
	body     io.ReadCloser
	cancel   context.CancelFunc
}

func (stream *attributedBody) Read(buffer []byte) (int, error) {
	count, err := stream.body.Read(buffer)
	if err != nil && !errors.Is(err, io.EOF) {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return count, err
		}
		stream.response.Truncated = true
		return count, fmt.Errorf("provider %s closed the connection mid-response: %w", stream.host, err)
	}
	return count, err
}

func (stream *attributedBody) Close() error {
	if stream.cancel != nil {
		stream.cancel()
	}
	return stream.body.Close()
}

// isTransportOwnedHeader reports the headers this client must own. Dropping Accept-Encoding is what
// makes decompression work at all: net/http only decodes gzip when IT chose the encoding, and it will
// not override a caller who set the header.
func isTransportOwnedHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "accept-encoding", "host", "content-length", "connection", "transfer-encoding":
		return true
	}
	return false
}

// explainTransportError names the host and the stage, and never carries a credential. The outer
// *url.Error is deliberately unwrapped: its Error() embeds the full URL, and a provider base URL can
// carry a key in the query string (`?key=` for makersuite), so returning it verbatim would print the
// operator's secret into a log.
func explainTransportError(err error, host string) error {
	cause := err
	var urlError *url.Error
	if errors.As(err, &urlError) && urlError.Err != nil {
		cause = urlError.Err
	}

	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("timeout waiting for provider %s to answer: %w", host, cause)
	}
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("request to provider %s was cancelled: %w", host, cause)
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		return fmt.Errorf("dns lookup for provider %s failed: %w", host, cause)
	}
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		return fmt.Errorf("tls handshake with provider %s failed: untrusted certificate: %w", host, cause)
	}
	var hostnameError x509.HostnameError
	if errors.As(err, &hostnameError) {
		return fmt.Errorf("tls handshake with provider %s failed: certificate does not match the host: %w", host, cause)
	}
	var certificateError x509.CertificateInvalidError
	if errors.As(err, &certificateError) {
		return fmt.Errorf("tls handshake with provider %s failed: invalid certificate: %w", host, cause)
	}
	message := err.Error()
	if strings.Contains(message, "proxyconnect") {
		return fmt.Errorf("proxy CONNECT for provider %s failed: %w", host, cause)
	}
	var opError *net.OpError
	if errors.As(err, &opError) && opError.Op == "dial" {
		return fmt.Errorf("connect to provider %s failed: %w", host, cause)
	}
	if strings.Contains(message, "tls:") || strings.Contains(message, "x509:") {
		return fmt.Errorf("tls handshake with provider %s failed: %w", host, cause)
	}
	return fmt.Errorf("request to provider %s failed: %w", host, cause)
}

// providerHost returns the authority of a request URL, for error messages only. The URL is never
// placed in a message, because it may carry a key.
func providerHost(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return "the provider"
	}
	return parsed.Host
}

func responseReason(status string) string {
	if index := strings.IndexByte(status, ' '); index >= 0 && index+1 < len(status) {
		return status[index+1:]
	}
	return status
}

// ---------------------------------------------------------------- the user's configured proxy (D3, second half)

// requestProxyConfig is what ConfigureRequestProxy stores. It is read on every request rather than captured
// when a client is built, because the client cache is keyed by TLS config and a proxy configured after a
// client exists would otherwise be invisible (the "capability that never reaches the behaviour" failure).
type requestProxyConfig struct {
	enabled bool
	url     *url.URL
	bypass  []string
}

var requestProxy atomic.Value // requestProxyConfig

// ConfigureRequestProxy applies pinned's requestProxy setting to provider traffic.
//
// RULE 1: an explicit setting in the user's config wins over the environment, and the two are never merged --
// a shell export somebody forgot about must not silently override what the config says. When it is disabled
// the environment (including NO_PROXY) applies exactly as before, so a user who never configured this keeps
// working.
//
// RULE 2: enabling a proxy without a usable URL is an ERROR, not a silent fallback to a direct dial. That
// typo is the difference between "my provider is unreachable" and a message naming the setting.
func ConfigureRequestProxy(enabled bool, rawURL string, bypass []string) error {
	config := requestProxyConfig{enabled: enabled, bypass: bypass}
	if enabled {
		trimmed := strings.TrimSpace(rawURL)
		if trimmed == "" {
			return fmt.Errorf("request proxy is enabled but no proxy URL is configured (requestProxy.url is empty); set it to an absolute URL such as http://proxy.example:3128, or disable requestProxy")
		}
		parsed, err := url.Parse(trimmed)
		if err != nil || !parsed.IsAbs() || parsed.Host == "" {
			return fmt.Errorf("request proxy is enabled with an unusable proxy URL %q: it must be absolute and carry a host, such as http://proxy.example:3128", trimmed)
		}
		config.url = parsed
	}
	requestProxy.Store(config)
	return nil
}

// providerProxy is what http.Transport calls for each request.
func providerProxy(request *http.Request) (*url.URL, error) {
	stored, _ := requestProxy.Load().(requestProxyConfig)
	if !stored.enabled {
		return http.ProxyFromEnvironment(request)
	}
	if request != nil && request.URL != nil && matchesProxyBypass(request.URL.Hostname(), stored.bypass) {
		return nil, nil
	}
	return stored.url, nil
}

// matchesProxyBypass reports whether host is excluded from the configured proxy. Accepted forms are the
// exact host ("example.com"), a leading-dot suffix (".example.com") and the wildcard spellings pinned's
// config documents ("*.example.com"), all case-insensitive. A bare suffix without a dot is NOT accepted as a
// suffix, because "ample.com" must not match "example.com".
func matchesProxyBypass(host string, bypass []string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return false
	}
	for _, raw := range bypass {
		candidate := strings.ToLower(strings.TrimSpace(raw))
		candidate = strings.TrimPrefix(candidate, "*.")
		candidate = strings.TrimPrefix(candidate, ".")
		if candidate == "" {
			continue
		}
		if host == candidate || strings.HasSuffix(host, "."+candidate) {
			return true
		}
	}
	return false
}
