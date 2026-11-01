package server

// The pinned deprecated redirect aliases — ALL FIFTY of them.
//
// THE PINNED SOURCE, IN FULL (src/server-startup.js:66-134):
//
//	export function redirectDeprecatedEndpoints(app) {
//	    function redirect(src, destination) {
//	        app.use(src, (req, res) => {
//	            console.warn(`API endpoint ${src} is deprecated; use ${destination} instead`);
//	            // HTTP 301 causes the request to become a GET. 308 preserves the request method.
//	            res.redirect(308, destination);
//	        });
//	    }
//	    redirect('/createcharacter', '/api/characters/create');
//	    ... 50 calls, src/server-startup.js:84-133 ...
//	}
//
// WHAT THAT MEANS OBSERVABLY, measured by tools/probe-redirect-aliases.mjs against the pinned server
// (tests/oracle/sillytavern-1.19.0-redirect-aliases.json, replayed by TestDeprecatedRedirectAliasesMatchPinnedOracle):
//
//   - STATUS: 308 for every method. The pinned comment is explicit about why 301 is wrong, and a redirect
//     that turned POST into GET would lose the body of every legacy form submission.
//   - LOCATION: `res.redirect(308, destination)` sends the destination string EXACTLY. It is a relative
//     Location, not an absolute one, and the request's query string is NOT appended — the handler never
//     reads req.url. `/createcharacter?probe=1` therefore redirects to bare
//     `/api/characters/create`.
//   - MOUNT SEMANTICS: `app.use(src, handler)` is a PREFIX mount, not an exact route. A subpath
//     (`/createcharacter/extra`) and a trailing slash (`/createcharacter/`) reach the alias; a longer name
//     (`/createcharacterx`) does not, because Express requires the next path character to be `/` or the end
//     of the path. No Go wildcard covers "exact segment boundary plus arbitrary remainder", so each alias
//     registers its exact pattern AND its `/`-subtree pattern; the exact pattern handles the empty remainder
//     and the subtree pattern handles subpaths.
//   - BODY: `res.redirect` calls `res.format`, so the body follows the `Accept` header: `text/plain` gets
//     `<StatusText>. Redirecting to <location>`, `text/html` gets the same sentence inside `<p>`, and a
//     non-matching Accept gets an EMPTY body. serveRedirect (http.go) already reproduces this shape for the
//     pinned callback and login redirects, so the alias uses it rather than a second implementation.
//   - WARNING: every request emits `API endpoint <src> is deprecated; use <destination> instead` on
//     console.warn. It is a `console.warn`, so the post-startup `logging.minLogLevel` gate applies
//     (console.go reproduces that gate); the line is not deduplicated upstream.
//   - `:folder` IS NOT INTERPOLATED. `/listimgfiles/:folder` is a path-to-regexp PARAM on the mount, but the
//     destination string is the literal `/api/images/list/:folder`, because the handler ignores the params.
//     The probe recorded that literal Location, so it is reproduced rather than "fixed" into a real folder.
//     path-to-regexp's parameter requires a NON-EMPTY segment, so `/listimgfiles` and `/listimgfiles/` do
//     not match the alias and fall through to the final 404.
//
// WHERE THE OTHER THIRTEEN WENT: /getstats, /updatestats, /recreatestats used to be registered by stats.go
// with `http.Redirect(..., StatusFound)` — a 302, which is NOT what pinned sends — and /getworldinfo,
// /deleteworldinfo, /importworldinfo, /editworldinfo by worldinfo.go, and /savetheme, /savemovingui,
// /getuseravatars, /deleteuseravatar, /savequickreply, /deletequickreply inline in http.go. All of them are
// rows of THIS table now, so one implementation serves all fifty and the 302 bug cannot come back through a
// second registration site. The three stats aliases were red in the pinned differential before this change
// and are 308 now.
//
// A NOTE ON AUTH ORDER, recorded rather than hidden: pinned mounts the aliases AFTER requireLoginMiddleware
// (src/server-main.js:248 then :277), so in account mode an unauthenticated request is redirected to /login
// instead of reaching the alias. GoTavern's single account-mode gate answers 403 before the mux, for every
// private route; that is the middleware contract this file inherits, not alias behaviour. The recorded
// differential therefore runs in the pinned default single-user mode, where both servers reach the alias.

import (
	"io"
	"net/http"
	"os"
	"strings"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerDeprecatedRedirectAliases)
}

// redirectAliasWarnings receives the pinned deprecation `console.warn` line. It is an option rather than a
// package variable so a test can capture it without racing a parallel test.
func (options HTTPHandlerOptions) redirectAliasWarnings() io.Writer {
	if options.redirectWarnings != nil {
		return options.redirectWarnings
	}
	return os.Stderr
}

// redirectAliasTable is the ordered pinned table from src/server-startup.js:84-133. The pinned line number is
// part of each row so a reviewer can check a row against the pinned file without searching it.
//
// The table is an inline `[]struct{...}{...}` literal on purpose: tools/compat-matrix/surface-coverage.mjs
// resolves a `for ... range <identifier>` registration table by reading this declaration shape, and a named
// element type (`[]pinnedRedirectAlias{...}`) is not one it can resolve -- the drift gate would then fail
// closed and report an unparsed HandleFunc site. See redirect_aliases_test.go for the replay of all 111
// pinned cases.
var redirectAliasTable = []struct {
	source      string
	destination string
	pinnedLine  int
}{
	{"/createcharacter", "/api/characters/create", 84},
	{"/renamecharacter", "/api/characters/rename", 85},
	{"/editcharacter", "/api/characters/edit", 86},
	{"/editcharacterattribute", "/api/characters/edit-attribute", 87},
	{"/v2/editcharacterattribute", "/api/characters/merge-attributes", 88},
	{"/deletecharacter", "/api/characters/delete", 89},
	{"/getcharacters", "/api/characters/all", 90},
	{"/getonecharacter", "/api/characters/get", 91},
	{"/getallchatsofcharacter", "/api/characters/chats", 92},
	{"/importcharacter", "/api/characters/import", 93},
	{"/dupecharacter", "/api/characters/duplicate", 94},
	{"/exportcharacter", "/api/characters/export", 95},
	{"/savechat", "/api/chats/save", 96},
	{"/getchat", "/api/chats/get", 97},
	{"/renamechat", "/api/chats/rename", 98},
	{"/delchat", "/api/chats/delete", 99},
	{"/exportchat", "/api/chats/export", 100},
	{"/importgroupchat", "/api/chats/group/import", 101},
	{"/importchat", "/api/chats/import", 102},
	{"/getgroupchat", "/api/chats/group/get", 103},
	{"/deletegroupchat", "/api/chats/group/delete", 104},
	{"/savegroupchat", "/api/chats/group/save", 105},
	{"/getgroups", "/api/groups/all", 106},
	{"/creategroup", "/api/groups/create", 107},
	{"/editgroup", "/api/groups/edit", 108},
	{"/deletegroup", "/api/groups/delete", 109},
	{"/getworldinfo", "/api/worldinfo/get", 110},
	{"/deleteworldinfo", "/api/worldinfo/delete", 111},
	{"/importworldinfo", "/api/worldinfo/import", 112},
	{"/editworldinfo", "/api/worldinfo/edit", 113},
	{"/getstats", "/api/stats/get", 114},
	{"/recreatestats", "/api/stats/recreate", 115},
	{"/updatestats", "/api/stats/update", 116},
	{"/getbackgrounds", "/api/backgrounds/all", 117},
	{"/delbackground", "/api/backgrounds/delete", 118},
	{"/renamebackground", "/api/backgrounds/rename", 119},
	{"/downloadbackground", "/api/backgrounds/upload", 120},
	{"/savetheme", "/api/themes/save", 121},
	{"/getuseravatars", "/api/avatars/get", 122},
	{"/deleteuseravatar", "/api/avatars/delete", 123},
	{"/uploaduseravatar", "/api/avatars/upload", 124},
	{"/deletequickreply", "/api/quick-replies/delete", 125},
	{"/savequickreply", "/api/quick-replies/save", 126},
	{"/uploadimage", "/api/images/upload", 127},
	{"/listimgfiles/:folder", "/api/images/list/:folder", 128},
	{"/api/content/import", "/api/content/importURL", 129},
	{"/savemovingui", "/api/moving-ui/save", 130},
	{"/api/serpapi/search", "/api/search/serpapi", 131},
	{"/api/serpapi/visit", "/api/search/visit", 132},
	{"/api/serpapi/transcript", "/api/search/transcript", 133},
}

func registerDeprecatedRedirectAliases(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	for _, alias := range redirectAliasTable {
		alias := alias
		handle := func(w http.ResponseWriter, request *http.Request) {
			consoleWarnf(options.redirectAliasWarnings(), "API endpoint %s is deprecated; use %s instead\n", alias.source, alias.destination)
			serveRedirect(w, request, http.StatusPermanentRedirect, alias.destination)
		}
		// The exact mount path. For the one parameterised alias this is the literal `:folder` spelling, which
		// is also what a request naming the placeholder literally reaches on pinned (the param matches any
		// non-empty segment, including `:folder`).
		mux.HandleFunc(alias.source, handle)
		if parameterStart := strings.Index(alias.source, "/:"); parameterStart >= 0 {
			// A path-to-regexp parameter requires a non-empty segment, so the subtree form must NOT answer
			// the bare prefix: `/listimgfiles/` falls through to the final 404 on pinned.
			base := alias.source[:parameterStart]
			// The bare prefix needs its OWN exact pattern. Without it net/http's ServeMux answers
			// GET /listimgfiles with a 301 to /listimgfiles/ (its implicit slash redirect for a registered
			// subtree), while pinned falls through to the final 404 — measured: the pinned capture records
			// 404 for `/listimgfiles`.
			mux.HandleFunc(base, func(w http.ResponseWriter, request *http.Request) {
				serveStatic(w, request, notFoundPage, options)
			})
			mux.HandleFunc(base+"/", func(w http.ResponseWriter, request *http.Request) {
				if strings.TrimPrefix(request.URL.Path, base+"/") == "" {
					serveStatic(w, request, notFoundPage, options)
					return
				}
				handle(w, request)
			})
			continue
		}
		// app.use matches subpaths; the exact pattern above does not.
		mux.HandleFunc(alias.source+"/", handle)
	}
}
