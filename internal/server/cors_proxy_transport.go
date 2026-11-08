package server

// THE CORS PROXY'S OUTBOUND CLIENT.
//
// WHY THIS IS NOT `outbound.SendStreaming`: the production provider client deliberately OWNS
// Accept-Encoding (it advertises only what it can decode and lets net/http decompress gzip), while this
// route must put the pinned wire value `gzip, deflate, br` on the request and decode the reply itself.
// `outbound` also exposes no way to carry a request into its client with a caller-supplied
// Accept-Encoding, and this lane may not edit it. What is reproduced from that client here, because it is
// the product's transport policy rather than a provider detail: bounded connect/TLS/response-header/idle
// timeouts, environment proxy support, no HTTP/2 (node-fetch is HTTP/1.1), node-fetch's redirect contract,
// and a shared client so keep-alive is real.
//
// WHAT THIS CLIENT DOES NOT DO, recorded so nobody assumes it does:
//   - it does NOT support brotli. The pinned accept-encoding is forced verbatim, and a br reply is retried
//     once without br for GET/HEAD (see corsProxyDoWithBrotliFallback in cors_proxy.go); a non-idempotent
//     request is refused with 500 "Internal Server Error" rather than re-sent, because a second POST could
//     duplicate a side effect. This is the one encoding pinned decodes that Go's standard library cannot.
//   - requestProxy.* and privateAddressWhitelist.* ARE applied, through the exported
//     outbound.UserURLDialContext / outbound.UserURLProxy policy: pinned installs both on the global
//     agents, so /proxy traffic is covered there too. A config change reaches this client without a
//     rebuild because the policy is read per dial/request.
//
// THE SSRF POLICY (deliberate, tested, named):
//   - schemes other than http/https are refused with the same 500 pinned's fetch produces, so that parity
//     is exact;
//   - loopback and RFC1918 targets are ALLOWED: proxying a local model server (127.0.0.1:5001 and the
//     like) is the feature's real use case, and pinned's default (filter disabled) allows them too;
//   - the well-known cloud metadata endpoints are ALWAYS refused, even though pinned would proxy them.
//     That is a visible hardening divergence: no legitimate extension proxies a metadata service, and the
//     address set is small enough not to collide with a local model server. The refusal is 500 with the
//     same body as any other upstream failure (no information leak); the reason is logged and the tests
//     that name it are TestCorsProxyRefusesCloudMetadataLiteralTargets and
//     TestCorsProxyRefusesHostnamesAndRedirectsThatResolveToCloudMetadata.
//   - DNS REBINDING is closed by construction: the dialer resolves the host ONCE, checks every resolved
//     address, and connects to a checked address only (the same property outbound's private filter has).

import (
	"bufio"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

// Bounds. pinned's node-fetch has none, so an unreachable or silent upstream parked a browser request
// forever; these are the deliberate divergence (recorded in the lane report, not in docs/):
// dial 30s, TLS handshake 15s, response header 120s, idle pooled connection 90s, and a body that may be
// silent for 120s between reads. There is deliberately NO whole-response deadline: a large download or a
// slow stream is legitimate, and its duration is bounded by the client's own connection lifetime.
const (
	corsProxyConnectTimeout        = 30 * time.Second
	corsProxyTLSHandshakeTimeout   = 15 * time.Second
	corsProxyResponseHeaderTimeout = 120 * time.Second
	corsProxyIdleConnTimeout       = 90 * time.Second
	corsProxyMaxIdleConnections    = 32
	// corsProxyMaxRedirects is node-fetch's follow default (src/request.js:134): the 21st redirect is
	// rejected. Go's own default of 10 is a different product's number (the same defect outbound fixed).
	corsProxyMaxRedirects = 20
)

// corsProxyBodyIdleTimeout is a variable so a test can prove the bound fires; production never changes it.
var corsProxyBodyIdleTimeout = 120 * time.Second

// The two network seams, as variables for the hermetic metadata tests. Production uses the system
// resolver and the PRODUCTION transport's own dial policy; a test substitutes a resolver that maps a name
// onto a metadata address and a dialer that records what would have been dialled.
var (
	corsProxyResolveAddresses = func(ctx context.Context, host string) ([]netip.Addr, error) {
		return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}
	// outbound.UserURLDialContext is the provider transport's dial policy: the operator's requestProxy and
	// privateAddressWhitelist apply to /proxy exactly as pinned applies them (it replaces the GLOBAL agents,
	// src/request-proxy.js:49-55 and src/private-request-filter.js:252-255). The addresses handed to it are
	// already resolved and metadata-checked below, so the filter validates the exact address dialled.
	corsProxyDialAddress = outbound.UserURLDialContext()
)

// corsProxyCloudMetadataAddresses is the address set always refused. AWS/GCP/Azure/OpenStack share
// 169.254.169.254, ECS task metadata is 169.254.170.2, AWS IMDSv6 is fd00:ec2::254, and Alibaba Cloud
// uses 100.100.100.200. The list is deliberately exact addresses rather than 169.254.0.0/16, so a
// legitimate link-local local service is not caught by the hardening.
var corsProxyCloudMetadataAddresses = []netip.Addr{
	netip.MustParseAddr("169.254.169.254"),
	netip.MustParseAddr("169.254.170.2"),
	netip.MustParseAddr("fd00:ec2::254"),
	netip.MustParseAddr("100.100.100.200"),
}

// corsProxyMetadataRefusal is the typed policy refusal, so a caller (and a test) can tell it apart from a
// peer that is simply not listening. It never carries the target URL, only the address.
type corsProxyMetadataRefusal struct {
	Address netip.Addr
}

func (refusal *corsProxyMetadataRefusal) Error() string {
	return "CORS proxy refused a cloud metadata endpoint: " + refusal.Address.String()
}

// corsProxyIsCloudMetadataAddress canonicalises a v4-mapped v6 address first, so ::ffff:169.254.169.254
// cannot walk past the IPv4 entry (the same inherited-bypass class outbound records for its filter).
func corsProxyIsCloudMetadataAddress(address netip.Addr) bool {
	if address.Is4In6() {
		address = address.Unmap()
	}
	for _, blocked := range corsProxyCloudMetadataAddresses {
		if address == blocked {
			return true
		}
	}
	return false
}

func corsProxyRefuseCloudMetadata(address netip.Addr) error {
	if !corsProxyIsCloudMetadataAddress(address) {
		return nil
	}
	return &corsProxyMetadataRefusal{Address: address}
}

var (
	corsProxyClientOnce sync.Once
	corsProxyClient     *http.Client
)

// corsProxyHTTPClient returns the one shared client. Sharing is what makes keep-alive real; the client
// carries no per-request state, and its dialer reads the policy and the installed seams at dial time.
func corsProxyHTTPClient() *http.Client {
	corsProxyClientOnce.Do(func() {
		transport := &http.Transport{
			// THE SAME POLICY AS PROVIDER TRAFFIC: pinned installs its request proxy and its private
			// request filter on the global agents, so /proxy honours requestProxy.* and
			// privateAddressWhitelist.* too. Both are read per request/dial, so a setting applied after this
			// client exists still takes effect.
			Proxy:                 outbound.UserURLProxy(),
			DialContext:           corsProxyDialContext,
			TLSHandshakeTimeout:   corsProxyTLSHandshakeTimeout,
			ResponseHeaderTimeout: corsProxyResponseHeaderTimeout,
			IdleConnTimeout:       corsProxyIdleConnTimeout,
			MaxIdleConns:          corsProxyMaxIdleConnections,
			MaxIdleConnsPerHost:   corsProxyMaxIdleConnections,
			// node-fetch 3.3.2 speaks HTTP/1.1 only; letting net/http negotiate h2 would change the
			// upstream's observable protocol.
			ForceAttemptHTTP2: false,
			// This route puts pinned's accept-encoding on the request itself and decodes the reply, so the
			// transport must not add or strip an encoding of its own.
			DisableCompression: true,
		}
		corsProxyClient = &http.Client{
			Transport:     transport,
			CheckRedirect: corsProxyCheckRedirect,
			// No whole-request deadline: the body-idle bound covers a stalled stream, and a legitimate
			// download has no duration contract.
		}
	})
	return corsProxyClient
}

// corsProxyDialContext is the single policy point: it resolves once, checks every address, and connects
// only to an address it checked. Redirect hops each open a new connection, so every hop is checked too.
func corsProxyDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("CORS proxy cannot parse the dial address %q: %w", address, err)
	}
	if literal, literalErr := netip.ParseAddr(host); literalErr == nil {
		if refusal := corsProxyRefuseCloudMetadata(literal); refusal != nil {
			return nil, refusal
		}
		return corsProxyDialAddress(ctx, network, address)
	}
	addresses, lookupErr := corsProxyResolveAddresses(ctx, host)
	if lookupErr != nil {
		return nil, lookupErr
	}
	permitted := make([]netip.Addr, 0, len(addresses))
	var refusal error
	for _, candidate := range addresses {
		if blocked := corsProxyRefuseCloudMetadata(candidate); blocked != nil {
			if refusal == nil {
				refusal = blocked
			}
			continue
		}
		permitted = append(permitted, candidate)
	}
	if len(permitted) == 0 {
		if refusal != nil {
			return nil, refusal
		}
		return nil, fmt.Errorf("CORS proxy could not resolve %s", host)
	}
	var lastErr error
	for _, candidate := range permitted {
		connection, dialErr := corsProxyDialAddress(ctx, network, net.JoinHostPort(candidate.String(), port))
		if dialErr == nil {
			return connection, nil
		}
		lastErr = dialErr
	}
	return nil, lastErr
}

// corsProxyCheckRedirect is node-fetch's redirect contract (src/index.js:171-239):
//
//   - follow at most 20 redirects;
//   - on 303, and on 301/302 when the method was POST, the method becomes GET and the body is dropped
//     (Go does that itself);
//   - on 301/302 with any other method (PUT, PATCH, DELETE, OPTIONS, ...) node-fetch KEEPS the method and
//     re-sends the body. Go rewrites every non-GET/HEAD method to GET, so those two are restored here --
//     an upstream that receives a GET where pinned sent a PUT is a wire difference a user can see;
//   - authorization/www-authenticate/cookie/cookie2 are dropped when the destination changes domain (Go
//     does that) OR protocol (Go does not, so that half is applied here);
//   - node-fetch sends no Referer on a redirect, and net/http adds one, so it is removed.
func corsProxyCheckRedirect(next *http.Request, via []*http.Request) error {
	if len(via) > corsProxyMaxRedirects {
		return fmt.Errorf("CORS proxy stopped after %d redirects", corsProxyMaxRedirects)
	}
	if len(via) == 0 {
		return nil
	}
	previous := via[len(via)-1]
	if previous.URL != nil && next.URL != nil && previous.URL.Scheme != next.URL.Scheme {
		for _, name := range []string{"Authorization", "Www-Authenticate", "Cookie", "Cookie2"} {
			next.Header.Del(name)
		}
	}
	next.Header.Del("Referer")
	if next.Response == nil || (next.Response.StatusCode != http.StatusMovedPermanently && next.Response.StatusCode != http.StatusFound) {
		return nil
	}
	if previous.Method == http.MethodPost || previous.Method == http.MethodGet || previous.Method == http.MethodHead {
		return nil
	}
	next.Method = previous.Method
	next.Body = nil
	next.GetBody = nil
	next.ContentLength = 0
	if previous.GetBody != nil {
		body, err := previous.GetBody()
		if err != nil {
			return err
		}
		next.Body = body
		next.GetBody = previous.GetBody
		next.ContentLength = previous.ContentLength
	}
	return nil
}

// corsProxyResponseBody returns the bytes the client should see, decoded when pinned decodes them.
// node-fetch decompresses gzip, deflate and br regardless of status; Go's transport only decompresses gzip
// when IT chose the encoding, and this route chooses for it, so the decoding is explicit here.
func corsProxyResponseBody(response *http.Response, method string) (io.ReadCloser, error) {
	source := newCorsProxyIdleReader(response.Body, corsProxyBodyIdleTimeout)
	encoding := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Encoding")))
	// HEAD, 204 and 304 have no representation to decode; a decompressor on an empty stream would only
	// invent a failure pinned does not produce.
	if encoding == "" || encoding == "identity" || method == http.MethodHead ||
		response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusNotModified {
		return source, nil
	}
	switch encoding {
	case "gzip":
		reader, err := gzip.NewReader(source)
		if err != nil {
			_ = source.Close()
			return nil, fmt.Errorf("upstream answered content-encoding gzip but the body is not gzip")
		}
		return &corsProxyDecodedBody{reader: reader, source: source}, nil
	case "deflate":
		// `deflate` is ambiguous in the wild: zlib-wrapped or raw. The bufio wrapper keeps the bytes a
		// failed zlib header probe consumed available to the raw-deflate reader.
		buffered := bufio.NewReader(source)
		if reader, err := zlib.NewReader(buffered); err == nil {
			return &corsProxyDecodedBody{reader: reader, source: source}, nil
		}
		return &corsProxyDecodedBody{reader: flate.NewReader(buffered), source: source}, nil
	case "br":
		_ = source.Close()
		return nil, fmt.Errorf("upstream answered content-encoding br, which this build cannot decode")
	default:
		_ = source.Close()
		return nil, fmt.Errorf("upstream answered an unsupported content-encoding %q", encoding)
	}
}

// corsProxyDecodedBody pairs a decompressor with the stream it reads, because a gzip/zlib/flate reader's
// Close does not close the socket underneath it. Closing this closes the idle-bounded source, which is
// what releases the connection and stops the idle timer.
type corsProxyDecodedBody struct {
	reader io.Reader
	source io.ReadCloser
}

func (body *corsProxyDecodedBody) Read(buffer []byte) (int, error) { return body.reader.Read(buffer) }

func (body *corsProxyDecodedBody) Close() error { return body.source.Close() }

// corsProxyIdleReader bounds the silence between reads. It closes the upstream body when the bound fires,
// which unblocks a Read that is parked on a peer that accepted the request and then stopped talking.
type corsProxyIdleReader struct {
	source io.ReadCloser
	idle   time.Duration
	timer  *time.Timer
}

func newCorsProxyIdleReader(source io.ReadCloser, idle time.Duration) *corsProxyIdleReader {
	reader := &corsProxyIdleReader{source: source, idle: idle}
	if idle > 0 {
		reader.timer = time.AfterFunc(idle, func() { _ = source.Close() })
	}
	return reader
}

func (reader *corsProxyIdleReader) Read(buffer []byte) (int, error) {
	count, err := reader.source.Read(buffer)
	if reader.timer != nil {
		if err == nil {
			reader.timer.Reset(reader.idle)
		} else {
			reader.timer.Stop()
		}
	}
	return count, err
}

func (reader *corsProxyIdleReader) Close() error {
	if reader.timer != nil {
		reader.timer.Stop()
	}
	return reader.source.Close()
}

// corsProxyLogFailure mirrors pinned's `console.error('Error in CORS proxy middleware:', error)` line,
// with one deliberate difference: the URL is never printed. pinned's error text embeds the full target
// URL, which can carry an API key in its query string; AGENTS.md rule 35 forbids printing secrets.
func corsProxyLogFailure(reason string) {
	fmt.Fprintf(os.Stderr, "Error in CORS proxy middleware: %s\n", reason)
}

// corsProxyFailureReason names the stage without printing the URL.
func corsProxyFailureReason(err error) string {
	var metadata *corsProxyMetadataRefusal
	if errors.As(err, &metadata) {
		return metadata.Error()
	}
	var urlError *url.Error
	if errors.As(err, &urlError) && urlError.Err != nil {
		err = urlError.Err
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "upstream request timed out"
	}
	if errors.Is(err, context.Canceled) {
		return "upstream request was cancelled by the client"
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		return "upstream host could not be resolved"
	}
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		return "upstream TLS certificate is not trusted"
	}
	var hostnameError x509.HostnameError
	if errors.As(err, &hostnameError) {
		return "upstream TLS certificate does not match the host"
	}
	var certificateError x509.CertificateInvalidError
	if errors.As(err, &certificateError) {
		return "upstream TLS certificate is invalid"
	}
	var opError *net.OpError
	if errors.As(err, &opError) && opError.Op == "dial" {
		return "upstream connection failed"
	}
	return "upstream request failed"
}
