package outbound

// alpha.20 source-audit reproducer: the PROVIDER transport's redirect limit is one short of the pinned
// node-fetch contract.
//
// PINNED CONTRACT (read from the pinned node_modules, not memory):
//
//	node_modules/node-fetch/src/request.js:134  follow default 20
//	node_modules/node-fetch/src/index.js:178    if (request.counter >= request.follow) { reject('max-redirect') }
//	node_modules/node-fetch/src/index.js:189    counter: request.counter + 1   (set on the redirect request)
//
// counter starts at 0 on the first request and is incremented when a redirect is FOLLOWED, so the
// reject condition first becomes true on the response to the 21st request: node-fetch follows exactly
// TWENTY redirects and then refuses the twenty-first.
//
// Go's CheckRedirect receives `via` = every request issued so far, so before following redirect N the
// slice has length N: to follow 20, the test must be `len(via) > 20`. The transport used
// `len(via) >= 20`, which refuses redirect 20 and therefore follows only NINETEEN.
//
// The pre-existing a15 test could not see this: it pins a 12-redirect chain (allowed under both limits)
// and an endless loop (refused under both). The boundary between 19 and 20 was never measured.

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// redirectChainServer answers `redirects` redirects and then returns a JSON body. It counts every
// request it receives, so the test can assert the exact hop count rather than only the verdict.
func redirectChainServer(t *testing.T, redirects int) (*httptest.Server, *int64) {
	t.Helper()
	var hops int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hop := atomic.AddInt64(&hops, 1)
		if hop <= int64(redirects) {
			http.Redirect(w, r, fmt.Sprintf("/hop/%d", hop), http.StatusTemporaryRedirect)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(redirectJSON))
	}))
	t.Cleanup(server.Close)
	return server, &hops
}

// TestA20ProductionTransportFollowsPinnedTwentyRedirects is the RED reproducer: a chain of exactly 20
// redirects succeeds under pinned node-fetch (follow=20) and must succeed here.
func TestA20ProductionTransportFollowsPinnedTwentyRedirects(t *testing.T) {
	server, hops := redirectChainServer(t, 20)
	response, err := Send(context.Background(), Request{
		URL:    server.URL + "/start",
		Method: http.MethodGet,
	}, 10*time.Second)
	if err != nil {
		t.Fatalf("a chain of exactly 20 redirects failed: %v; pinned node-fetch follows 20 redirects "+
			"(follow default 20, reject on counter >= follow at src/index.js:178, counter incremented "+
			"at :189) and our CheckRedirect must reject only the 21st (len(via) > 20)", err)
	}
	if string(response.Body) != redirectJSON {
		t.Fatalf("body = %q, want the final provider JSON", string(response.Body))
	}
	if got := atomic.LoadInt64(hops); got != 21 {
		t.Fatalf("the chain of 20 redirects issued %d requests, want 21 (initial + 20 redirects)", got)
	}
}

// TestA20ProductionTransportRejectsTheTwentyFirstRedirect pins the other side of the same boundary: the
// 21st redirect is refused (node-fetch's reject fires on the response to request 21), and the request
// count proves the limit is 20, not 19.
func TestA20ProductionTransportRejectsTheTwentyFirstRedirect(t *testing.T) {
	server, hops := redirectChainServer(t, 1000) // always redirects
	_, err := Send(context.Background(), Request{
		URL:    server.URL + "/start",
		Method: http.MethodGet,
	}, 10*time.Second)
	if err == nil {
		t.Fatalf("an endless redirect chain returned no error; pinned rejects after 20 followed redirects")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "redirect") {
		t.Fatalf("redirect-limit error = %v, want it to name the redirect failure", err)
	}
	if got := atomic.LoadInt64(hops); got != 21 {
		t.Fatalf("the endless chain issued %d requests before giving up, want 21: node-fetch follows "+
			"20 redirects and refuses the 21st, so a Go client that refuses the 20th is one short", got)
	}
}
