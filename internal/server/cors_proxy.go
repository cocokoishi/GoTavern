package server

import (
	"net/http"
)

// pinnedCorsProxyDisabledMessage is the exact body pinned sends when the CORS proxy is disabled:
//
//	// server-main.js:260-264
//	app.use('/proxy/:url(*)', async (_, res) => {
//	    const message = 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.';
//	    console.log(message);
//	    res.status(404).send(message);
//	});
//
// Express's res.send(string) sends text/html with that exact byte sequence, so the 404 status AND the
// body are both observable to an extension that probes the route. GoTavern previously registered no
// /proxy/ pattern at all, so the disabled branch answered Go's generic "404 page not found" page.
const pinnedCorsProxyDisabledMessage = "CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag."

// pinnedCorsProxyUnimplementedMessage is the named reason the ENABLED branch answers. Pinned proxies
// arbitrary URLs there; GoTavern does not implement the proxy yet, and AGENTS.md rule 17 requires an
// unimplemented branch to be DISTINGUISHABLE from a policy refusal rather than sharing the refusal's
// status. A 501 that names the boundary keeps "the operator disabled it" (404, pinned body) and "the
// feature does not exist here" (501) separable, and it never fabricates a proxied response.
const pinnedCorsProxyUnimplementedMessage = "CORS proxy is enabled but not implemented by GoTavern: no request was proxied."

// registerCorsProxyRoutes mirrors the pinned /proxy/:url(*) mount (server-main.js:257-265).
//
// The route is mounted by pinned in BOTH branches, so its absence in GoTavern was a surface gap: a
// browser extension (or a user) probing /proxy/... received Go's generic 404 instead of the pinned
// message. The CSRF layer already special-cases this path (csrf_session.go:192), which is the one
// place the surface was visible before this route existed.
func registerCorsProxyRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/proxy/", func(w http.ResponseWriter, request *http.Request) {
		if !options.EnableCorsProxy {
			respondText(w, http.StatusNotFound, "text/html; charset=utf-8", pinnedCorsProxyDisabledMessage)
			return
		}
		respondText(w, http.StatusNotImplemented, "text/html; charset=utf-8", pinnedCorsProxyUnimplementedMessage)
	})
}
