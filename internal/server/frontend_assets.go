package server

// Three pinned user-data asset routes (and one data-root override) that GoTavern did not serve at all. The extension E2E pair found
// both as 404s where pinned answered 200, and neither is an extension problem: they are the pinned
// frontend's own asset contract.
//
// 1. GET `/backgrounds/*` — `src/users.js:1213`:
//
//	router.use('/backgrounds/*', createRouteHandler(req => req.user.directories.backgrounds));
//
//    createRouteHandler (users.js:1092-1112) decodes the wildcard capture, joins it under the USER's
//    backgrounds directory, rejects a path that escapes it with 403, answers 404 when the file is
//    absent, and otherwise res.sendFile()s it. The router is the private one, so the route requires a
//    session; the response is send()'s, with the file's ETag and Last-Modified — which is why a
//    revalidation can answer 304 here and never does for GoTavern's embedded assets.
//
//    The defect this closes was self-contradictory rather than merely missing: `/api/backgrounds/all`
//    listed `__transparent.png` while `/backgrounds/__transparent.png` answered 404, so the server's
//    own listing named a file it refused to serve.
//
// 2. GET `/css/user.css` — `src/middleware/userCss.js`, mounted at `src/server-main.js:241`, BEFORE
//    `express.static` at :242 and before requireLoginMiddleware at :248:
//
//	function userCssMiddleware(req, res, next) {
//	    if (req.method === 'GET' && req.path === '/css/user.css') {
//	        const userCssPath = path.resolve(path.join(globalThis.DATA_ROOT, '_css', 'user.css'));
//	        if (fs.existsSync(userCssPath)) { res.sendFile(userCssPath); return; }
//	    }
//	    next();
//	}
//
//    Two consequences that a plain static route would get wrong: the override is DATA, not an embedded
//    asset, so it must be served even though nothing under `public/css/user.css` exists; and because
//    the middleware runs before the login middleware, it is ANONYMOUS — an unauthenticated browser
//    gets the user's stylesheet. ARCHITECTURE 2.2 lists user-CSS override behaviour as part of the
//    frontend ABI, so this is a contract item rather than a convenience.
//
// Both handlers reuse sendPinnedExtensionBytes, which is this repository's reproduction of send()'s
// conditional-GET, Range, ETag/Last-Modified and error behaviour; they must not grow a second,
// divergent copy of those semantics.

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerFrontendAssetRoutes)
}

// userDataMounts is the GoTavern registration for the pinned user-data static trees. Pinned declares
// SEVEN mounts at src/users.js:1213-1219:
//
//	router.use('/backgrounds/*',                    ... directories.backgrounds);   :1213
//	router.use('/characters/*',                     ... directories.characters);    :1214
//	router.use('/User%20Avatars/*',                 ... directories.avatars);       :1215
//	router.use('/assets/*',                         ... directories.assets);        :1216
//	router.use('/user/images/*',                    ... directories.userImages);    :1217
//	router.use('/user/files/*',                     ... directories.files);         :1218
//	router.use('/scripts/extensions/third-party/*', ... directories.extensions);    :1219
//	                                                   (served by the frontend static path)
//
// THE THREE USER-DATA ROWS IN THE MIDDLE WERE MISSING, and that is why a real user's page showed
// broken images: a character's full-size avatar, its sprites and its live2d are all fetched from
// /characters/<file>.png, which answered 404 while /characters/ existed on disk as a directory nobody
// could fetch (AGENTS.md 42/44). No fixture requested those URLs, so nothing failed. The list is a
// package-level value so the inventory test diffs it against the pinned declarations instead of
// trusting this comment.
//
// /User%20Avatars/* is registered with the ESCAPED spelling, and that is not cosmetic. net/http's
// pattern parser (src/net/http/pattern.go:96) splits a pattern on the FIRST space to separate an
// optional method, so a pattern containing a literal space is read as method "/User", rejected as an
// invalid method, and mux.HandleFunc PANICS at registration. Registering "/User Avatars/{rest...}"
// therefore took the whole server down before it opened a port: measured on main, where every
// handler-constructing test failed with net/http.(*ServeMux).HandleFunc in the trace and the packaged
// binary exited 2 before answering GET /version. The escaped form is legal AND matches, because a
// pattern's literal segments are unescaped while it is parsed (pattern.go:148 pathUnescape) and
// matching compares unescaped path segments, so `User%20Avatars` and the request's `User Avatars`
// segment are the same segment.
var userDataMounts = []struct{ pattern, directoryKey string }{
	{"/backgrounds/{rest...}", "backgrounds"},
	{"/User%20Avatars/{rest...}", "avatars"},
	{"/assets/{rest...}", "assets"},
	{"/user/images/{rest...}", "userImages"},
	{"/user/files/{rest...}", "files"},
}

func registerFrontendAssetRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	// router.use matches every method, so neither pattern names one. The patterns need the trailing
	// slash for the same reason the pinned mount does: `/backgrounds` alone is not this route.

	// The same createRouteHandler shape serves every user-data asset tree (see userDataMounts). Each
	// one is a URL the pinned frontend fetches: chat images and uploaded files with a `?v=`
	// cache-buster the route ignores, character avatars/sprites/live2d, User Avatars, and the assets
	// tree. The extension E2E found two of them missing: LittleWhiteBox uploads its user data through
	// /api/files/upload and then reads it back through /user/files/<name>?v=..., which answered 404 on
	// GoTavern on every attempt while pinned answered 200 -- the extension could store state it could
	// never load. A user report found the other three.
	for _, userDataRoute := range userDataMounts {
		directoryKey := userDataRoute.directoryKey
		mux.HandleFunc(userDataRoute.pattern, func(w http.ResponseWriter, r *http.Request) {
			accounts.serveUserDataStatic(w, r, directoryKey, notFoundPage)
		})
	}
	mux.HandleFunc("/css/user.css", func(w http.ResponseWriter, r *http.Request) {
		accounts.serveUserCSS(w, r, notFoundPage)
	})
}

// serveUserDataStatic is createRouteHandler over one of the user's data directories. It is
// /backgrounds/*, /user/images/* and /user/files/*, kept as ONE implementation so there is one copy of the semantics: static wins when the embedded
// tree has the path, a capture that escapes the directory is 403, a missing file is res.sendStatus's
// 404 (text/plain, not the application page), and the transfer is send()'s.
func (runtime *accountRuntime) serveUserDataStatic(w http.ResponseWriter, r *http.Request, directoryKey string, notFoundPage []byte) {
	if pinnedFrontendStaticServes(runtime.options, r) {
		servePinnedFrontendStatic(w, r, notFoundPage, runtime.options)
		return
	}
	account, ok := runtime.settingsRequestAccount(w, r)
	if !ok {
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	filePath := r.PathValue("rest")
	if servePinnedExtensionRoot(w, r, directories[directoryKey], filePath, notFoundPage) {
		return
	}
	serveStatusText(w, http.StatusNotFound)
}

// serveUserCSS is the pinned userCssMiddleware: GET only, the override file if it exists, otherwise
// the request continues to the frontend static handler exactly as `next()` would.
func (runtime *accountRuntime) serveUserCSS(w http.ResponseWriter, r *http.Request, notFoundPage []byte) {
	if r.Method == http.MethodGet {
		if target, exists := userCSSOverridePath(runtime.options); exists {
			info, err := os.Stat(target)
			if err == nil && !info.IsDir() {
				sendPinnedExtensionBytes(w, r, target, info)
				return
			}
		}
	}
	serveStatic(w, r, notFoundPage, runtime.options)
}

// userCSSOverridePath returns the data-root CSS override, mirroring
// `path.resolve(path.join(globalThis.DATA_ROOT, '_css', 'user.css'))`. The path is GLOBAL (one file
// for the whole data root), not per user, which is why it is not derived from a handle.
func userCSSOverridePath(options HTTPHandlerOptions) (string, bool) {
	if options.DataRoot == "" {
		return "", false
	}
	target := filepath.Join(options.DataRoot, "_css", "user.css")
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		return "", false
	}
	return target, true
}

// userCSSOverrideIsPublic mirrors the middleware's position BEFORE requireLoginMiddleware: an
// anonymous browser is served the override when it exists. Without this the account gate would
// answer 403 for a stylesheet pinned serves to everyone, and the file's existence would be the only
// thing deciding publicness — which is exactly the pinned rule.
func userCSSOverrideIsPublic(r *http.Request, options HTTPHandlerOptions) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if r.URL.Path != "/css/user.css" {
		return false
	}
	_, exists := userCSSOverridePath(options)
	return exists
}
