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

func registerFrontendAssetRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	// router.use matches every method, so neither pattern names one. The patterns need the trailing
	// slash for the same reason the pinned mount does: `/backgrounds` alone is not this route.

	// The same createRouteHandler shape serves the three user-data asset trees; the two below are
	// src/users.js:1217-1218, and /backgrounds/* is :1213:
	//
	//	router.use('/user/images/*', createRouteHandler(req => req.user.directories.userImages));
	//	router.use('/user/files/*',  createRouteHandler(req => req.user.directories.files));
	//
	// They are the URLs the frontend fetches chat images and uploaded files from, with a `?v=`
	// cache-buster the route ignores (it decodes only the wildcard capture). The extension E2E found
	// them missing: LittleWhiteBox uploads its user data through /api/files/upload and then reads it
	// back through /user/files/<name>?v=..., which answered 404 on GoTavern on every attempt while
	// pinned answered 200 -- the extension could store state it could never load.
	for _, userDataRoute := range []struct{ pattern, directoryKey string }{
		{"/user/images/{rest...}", "userImages"},
		{"/user/files/{rest...}", "files"},
		{"/backgrounds/{rest...}", "backgrounds"},
	} {
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
