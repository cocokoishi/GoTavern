package server

import "net/http"

// domainRouteRegistrar registers the HTTP routes owned by one API domain.
//
// Each domain keeps its registrations in its own file and appends itself to
// domainRouteRegistrars from an init function, so implementing a new domain
// does not require editing a shared registration list. That matters because
// several domains are implemented in parallel against this package, and a
// single shared list would make every domain's change collide with every
// other domain's change.
//
// Registrars run once, before any handler is served. A domain must not depend
// on another domain's registrar having run, and must not register a route that
// another domain already owns: net/http panics on duplicate patterns, which
// surfaces the mistake immediately rather than silently shadowing a route.
type domainRouteRegistrar func(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions)

var domainRouteRegistrars []domainRouteRegistrar

// registerDomainRoutes runs every domain registrar.
func registerDomainRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	for _, register := range domainRouteRegistrars {
		register(mux, accounts, notFoundPage, options)
	}
}
