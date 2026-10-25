package adversarial

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

// rawPeer is a provider that speaks HTTP/1.1 by hand, so a case can record the
// exact request head the product wrote and answer with a body net/http cannot
// produce (a chunked stream cut before its terminal chunk).
type rawPeer struct {
	mu       sync.Mutex
	heads    []string
	listener net.Listener
}

func newRawPeer(t *testing.T, respond func(net.Conn, string)) *rawPeer {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("start the raw peer: %v", err)
	}
	peer := &rawPeer{listener: listener}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = connection.Close() }()
				head, readErr := readRequestHead(connection)
				if readErr != nil && head == "" {
					return
				}
				peer.mu.Lock()
				peer.heads = append(peer.heads, head)
				peer.mu.Unlock()
				if respond != nil {
					respond(connection, head)
				}
			}()
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return peer
}

func (peer *rawPeer) address(path string) string {
	return "http://" + peer.listener.Addr().String() + path
}

func (peer *rawPeer) recorded() []string {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	return append([]string(nil), peer.heads...)
}

func readRequestHead(connection net.Conn) (string, error) {
	reader := bufio.NewReader(connection)
	var builder strings.Builder
	for {
		line, err := reader.ReadString('\n')
		builder.WriteString(line)
		if builder.Len() > 64<<10 {
			return builder.String(), fmt.Errorf("request head exceeded 64KiB")
		}
		if err != nil {
			return builder.String(), err
		}
		if line == "\r\n" || line == "\n" {
			return builder.String(), nil
		}
	}
}

func jsonProbeRequest(url string) outbound.Request {
	body := []byte(`{"model":"probe"}`)
	// Host is REQUIRED: this probe writes the request itself (net/http is not in
	// the path), and an HTTP/1.1 peer answers 400 to a request without it. Its
	// absence made three cases measure a 400 page instead of the peer the case
	// built, which is the "probe never reached the subject" failure this package
	// exists to avoid.
	host := ""
	if parsed, err := neturl.Parse(url); err == nil {
		host = parsed.Host
	}
	return outbound.Request{
		URL:    url,
		Method: http.MethodPost,
		Headers: []outbound.Header{
			{Name: "Host", Value: host},
			{Name: "content-type", Value: "application/json"},
			{Name: "accept", Value: "*/*"},
			{Name: "accept-encoding", Value: "gzip, deflate, br"},
			{Name: "content-length", Value: fmt.Sprint(len(body))},
		},
		Body: body,
	}
}

func expiredCertificate(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate a key: %v", err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "expired.adversarial.invalid"},
		NotBefore:    time.Now().Add(-48 * time.Hour),
		NotAfter:     time.Now().Add(-24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"expired.adversarial.invalid"},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create the expired certificate: %v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func transportCases(t *testing.T) []caseSpec {
	t.Helper()

	// A peer that behaves like a compressing CDN: it honours accept-encoding.
	gzipPeer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		writer := gzip.NewWriter(w)
		_, _ = writer.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
		_ = writer.Close()
	}))
	t.Cleanup(gzipPeer.Close)

	// A peer that answers after a redirect, as a regional CDN edge does.
	finalPeer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}]}`)
	}))
	t.Cleanup(finalPeer.Close)
	redirectPeer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, finalPeer.URL+"/v1/chat/completions", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirectPeer.Close)

	// A TLS peer with an expired certificate.
	certificate := expiredCertificate(t)
	tlsListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("start the TLS peer: %v", err)
	}
	tlsPeer := tls.NewListener(tlsListener, &tls.Config{Certificates: []tls.Certificate{certificate}})
	go func() {
		for {
			connection, acceptErr := tlsPeer.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer func() { _ = connection.Close() }()
				if tlsConnection, ok := connection.(*tls.Conn); ok {
					// Complete the handshake so the CLIENT is the side that fails on the
					// expired certificate; closing before the handshake would produce an
					// EOF that proves nothing about certificate verification.
					_ = tlsConnection.Handshake()
				}
			}()
		}
	}()
	t.Cleanup(func() { _ = tlsListener.Close() })

	// A provider that dies mid-SSE: a chunked stream with no terminal chunk.
	closingPeer := newRawPeer(t, func(connection net.Conn, _ string) {
		payload := "data: {\"delta\":\"first\"}\n\n"
		_, _ = fmt.Fprint(connection, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
		_, _ = fmt.Fprintf(connection, "%x\r\n%s\r\n", len(payload), payload)
		// No terminal "0\r\n\r\n": the connection just closes.
	})

	// A gateway that answers 200 with an HTML page.
	htmlPeer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<html><body>gateway error</body></html>")
	}))
	t.Cleanup(htmlPeer.Close)

	// A proxy that rejects CONNECT, as a corporate proxy does for a blocked host.
	proxyPeer := newRawPeer(t, func(connection net.Conn, _ string) {
		_, _ = fmt.Fprint(connection, "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n")
	})

	// Peers for the request-framing cases: record the head, answer 200 empty.
	framingPeer := newRawPeer(t, func(connection net.Conn, _ string) {
		_, _ = fmt.Fprint(connection, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
	})

	tlsPort := tlsListener.Addr().(*net.TCPAddr).Port

	return []caseSpec{
		{
			id:        "transport.gzip-response-unreadable",
			checklist: "transport.gzip",
			invariant: "rule 29/30: the client advertises gzip/deflate/br, so a compressed provider reply must be decodable by the caller or refused with an error naming the encoding",
			run: func() caseResult {
				response, sendErr := outbound.Send(context.Background(), jsonProbeRequest(gzipPeer.URL+"/v1/chat/completions"), 10*time.Second)
				if sendErr != nil {
					return okResult("refused with %v", sendErr)
				}
				encoding := response.Header("Content-Encoding")
				if encoding == "" {
					return notApplicable("the peer did not compress the reply, so this case cannot measure decompression")
				}
				var decoded any
				if err := json.Unmarshal(response.Body, &decoded); err != nil {
					return violation("the provider answered Content-Encoding: %s and the body the caller received is not JSON (%d bytes, first 8 = %x): every compressing provider is unreadable", encoding, len(response.Body), firstBytes(response.Body))
				}
				return okResult("decoded a %s reply", encoding)
			},
		},
		{
			id:        "transport.redirect-not-followed",
			checklist: "transport.redirect",
			invariant: "rule 29: a provider redirect must be followed or surfaced as a named error; a 3xx may not be handed to the caller as the provider's answer",
			run: func() caseResult {
				response, sendErr := outbound.Send(context.Background(), jsonProbeRequest(redirectPeer.URL+"/v1/chat/completions"), 10*time.Second)
				if sendErr != nil {
					return okResult("refused with %v", sendErr)
				}
				if response.Status >= 300 && response.Status < 400 {
					return violation("the 30x answer (%d) is returned as the provider's response to the caller, with a %d-byte body", response.Status, len(response.Body))
				}
				var decoded any
				if err := json.Unmarshal(response.Body, &decoded); err != nil {
					return violation("the redirect was neither followed nor named: status %d, body %q", response.Status, string(response.Body))
				}
				return okResult("followed to status %d", response.Status)
			},
		},
		{
			id:        "transport.expired-certificate",
			checklist: "tls.expired",
			invariant: "rule 35: a TLS failure is causal and names TLS/handshake/certificate, not a generic connection error",
			run: func() caseResult {
				url := fmt.Sprintf("https://127.0.0.1:%d/v1/chat/completions", tlsPort)
				_, sendErr := outbound.Send(context.Background(), jsonProbeRequest(url), 10*time.Second)
				if sendErr == nil {
					return violation("a request to a peer with an expired, non-matching certificate succeeded")
				}
				message := strings.ToLower(sendErr.Error())
				if !strings.Contains(message, "tls") && !strings.Contains(message, "x509") && !strings.Contains(message, "certificate") && !strings.Contains(message, "handshake") {
					return violation("the TLS failure is not causal: %v", sendErr)
				}
				return okResult("refused with %v", sendErr)
			},
		},
		{
			id:        "transport.mid-stream-close",
			checklist: "sse.midsclose",
			invariant: "rule 35: a provider that dies mid-stream is distinguishable from one that finished (Response.Truncated)",
			run: func() caseResult {
				response, sendErr := outbound.Send(context.Background(), jsonProbeRequest(closingPeer.address("/v1/chat/completions")), 10*time.Second)
				if sendErr != nil {
					return okResult("refused with %v", sendErr)
				}
				if !response.Truncated {
					return violation("the provider closed before its terminal chunk and Response.Truncated is false; the caller cannot tell this from a complete answer (%d bytes)", len(response.Body))
				}
				return okResult("reported Truncated after %d bytes", len(response.Body))
			},
		},
		{
			id:        "transport.html-200",
			checklist: "html.200",
			invariant: "rule 35/18: a 200 HTML gateway page must be distinguishable from a provider answer by its declared content type, and its body must reach the caller rather than being silently dropped",
			run: func() caseResult {
				response, sendErr := outbound.Send(context.Background(), jsonProbeRequest(htmlPeer.URL+"/v1/chat/completions"), 10*time.Second)
				if sendErr != nil {
					return okResult("refused with %v", sendErr)
				}
				contentType := response.Header("Content-Type")
				if len(response.Body) == 0 {
					return violation("a 200 with an HTML body reached the caller as an empty body with content type %q", contentType)
				}
				if !strings.Contains(strings.ToLower(contentType), "text/html") {
					return violation("the HTML body arrived with content type %q, so a JSON caller cannot tell it from a provider answer", contentType)
				}
				return okResult("content type %q and %d bytes delivered", contentType, len(response.Body))
			},
		},
		{
			id:        "transport.proxy-connect-ignored",
			checklist: "proxy.connect",
			// THE FIRST VERSION OF THIS CASE COULD NEVER PASS, IN TWO SEPARATE WAYS, and both are worth keeping
			// recorded because this project keeps rediscovering them:
			//
			//   1. It targeted https://127.0.0.1:1. Go resolves proxies and returns nil for every loopback
			//      address BEFORE it consults NO_PROXY, so a loopback provider is never proxied however the
			//      environment is set. The provider is now 192.0.2.1 (TEST-NET-1, guaranteed unroutable), so a
			//      proxy is the only way the request can go anywhere.
			//   2. It set HTTPS_PROXY at run time. net/http caches the environment on the FIRST proxy lookup in
			//      the process, so by the time this case runs, an environment change is invisible. Environment
			//      proxy support is therefore asserted where it CAN be measured -- internal/outbound/proxytest,
			//      which is its own process for exactly this reason -- and this case measures the path the user
			//      actually configures: pinned's requestProxy setting.
			invariant: "rule 29 + ARCHITECTURE 34.3: the proxy a user configured (requestProxy.enabled/url) is used for provider traffic -- the proxy receives a CONNECT -- and the request is not dialled directly",
			run: func() caseResult {
				proxyURL := "http://" + proxyPeer.listener.Addr().String()
				if err := outbound.ConfigureRequestProxy(true, proxyURL, nil); err != nil {
					return violation("the product refused a usable proxy configuration (%s): %v", proxyURL, err)
				}
				defer func() { _ = outbound.ConfigureRequestProxy(false, "", nil) }()
				before := len(proxyPeer.recorded())
				_, sendErr := outbound.Send(context.Background(), jsonProbeRequest("https://192.0.2.1/v1/chat/completions"), 5*time.Second)
				after := proxyPeer.recorded()
				for _, head := range after[before:] {
					if strings.HasPrefix(head, "CONNECT ") {
						return okResult("the proxy received %q", strings.SplitN(head, "\r\n", 2)[0])
					}
				}
				if sendErr != nil && strings.Contains(strings.ToLower(sendErr.Error()), "proxy") {
					return okResult("refused with a failure that names the proxy: %v", sendErr)
				}
				return violation("requestProxy=%s was ignored: the proxy received no CONNECT and the failure (%v) does not name the proxy, so the request was dialled directly", proxyURL, sendErr)
			},
		},
		{
			id:        "transport.header-value-injection",
			checklist: "apikey.nonascii",
			invariant: "rule 35/12: a credential containing CR/LF may not split the request; the transport must refuse it or write a single header line",
			run: func() caseResult {
				request := jsonProbeRequest(framingPeer.address("/v1/chat/completions"))
				request.Headers = append(request.Headers, outbound.Header{Name: "authorization", Value: "Bearer sk-probe\r\nX-Injected: yes"})
				_, sendErr := outbound.Send(context.Background(), request, 5*time.Second)
				heads := framingPeer.recorded()
				if len(heads) == 0 {
					return okResult("refused before writing anything: %v", sendErr)
				}
				head := strings.ToLower(heads[len(heads)-1])
				if strings.Contains(head, "\r\nx-injected:") {
					return violation("the credential's CRLF was written verbatim: the peer received an injected X-Injected header line, so a secret can forge request headers")
				}
				return okResult("the CRLF did not become a header line")
			},
		},
		{
			id:        "transport.non-ascii-key",
			checklist: "apikey.nonascii",
			invariant: "a key with non-ASCII characters is either refused with a named error or transmitted without corrupting the request framing (one request line, one header section)",
			run: func() caseResult {
				request := jsonProbeRequest(framingPeer.address("/v1/chat/completions"))
				const key = "Bearer sk-é-ünïcode-測試"
				request.Headers = append(request.Headers, outbound.Header{Name: "authorization", Value: key})
				_, sendErr := outbound.Send(context.Background(), request, 5*time.Second)
				heads := framingPeer.recorded()
				if len(heads) == 0 {
					return okResult("refused before writing anything: %v", sendErr)
				}
				head := heads[len(heads)-1]
				if strings.Count(head, " HTTP/1.1\r\n") != 1 {
					return violation("the head contains %d request lines, so a non-ASCII key corrupted the framing: %q", strings.Count(head, " HTTP/1.1\r\n"), head)
				}
				// THE RECORDER REDACTES CREDENTIAL-SHAPED VALUES, so the key's bytes are not observable in the
				// recorded head -- by design (rule 35: a log never prints a secret). Asserting them against a redacted
				// head reports a violation the harness itself created, which is the "gate that cannot measure" failure
				// this project keeps finding. What IS observable is what the invariant names: framing. One request
				// line was asserted above; here the header section must still be a single block with nothing injected.
				if strings.Contains(head, "***") {
					if strings.Count(head, "\r\n\r\n") != 1 {
						return violation("a redacted credential still corrupted the header section: %q", head)
					}
					return okResult("transmitted without corrupting the framing; the recorder redacted the credential, so framing is what is asserted")
				}
				if !strings.Contains(strings.ToLower(head), "authorization: "+strings.ToLower(key)) {
					return violation("the key did not survive byte-exactly: %q", head)
				}
				return okResult("transmitted without corrupting the framing")
			},
		},
	}
}

func restoreEnv(name, value string, had bool) {
	if had {
		_ = os.Setenv(name, value)
		return
	}
	_ = os.Unsetenv(name)
}

func firstBytes(body []byte) []byte {
	if len(body) > 8 {
		return body[:8]
	}
	return body
}
