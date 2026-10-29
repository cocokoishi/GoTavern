package server

// THE CACHE BUSTER (G-05).
//
// Pinned src/middleware/cacheBuster.js is a module singleton whose middleware is mounted on exactly ONE
// route — the host index page:
//
//	src/server-main.js:214   app.get('/', cacheBuster.middleware, (request, response) => { ... })
//
// and whose `bust` method is called directly by three write routes that replace an image:
//
//	src/endpoints/avatars.js:51-54      POST /api/avatars/upload   (only when `overwrite_name` is set)
//	src/endpoints/characters.js:1132    POST /api/characters/edit  (only when a file was uploaded)
//	src/endpoints/characters.js:1173    POST /api/characters/edit-avatar
//
// The observable is one response header, and its exact bytes matter:
//
//	cacheBuster.js:103   response.setHeader('Clear-Site-Data', '"cache"');
//
// so the VALUE INCLUDES THE DOUBLE QUOTES. `Clear-Site-Data: cache` (unquoted) is not the pinned header
// and browsers treat the two differently, so the constant below is quoted.
//
// THE MIDDLEWARE'S ONCE-PER-KEY RULE (cacheBuster.js:72-85) is reproduced including the part that looks
// like a bug:
//
//	const handle = request.user?.profile?.handle || DEFAULT_USER.handle;   // constants.js:55 'default-user'
//	const hash = crypto.createHash('sha256').update(userAgent).digest('hex');
//	const key = `${handle}-${hash}`;
//	if (this.#keys.has(key)) return next();
//	this.#keys.add(key);          // <-- added BEFORE bust(), so the key is consumed even when the
//	this.bust(request, response); //     pattern does not match and no header is emitted
//	next();
//
// The key is therefore "one attempt per (handle, sha256(user-agent)) per process", not "one header per
// key". The difference is unobservable for a fixed config (the pattern test returns the same answer for
// the same user agent), but consuming the key in the same order is what makes this a reproduction
// rather than an approximation.
//
// `bust` (cacheBuster.js:45-66, :101-105) gates on `enabled`, on the response not having started yet,
// and on the user-agent pattern. In Go the header must be set before the first write, which is exactly
// where every call site below sits, so the "headers already sent" arm cannot be reached and is not
// invented here.
//
// A DIFFERENCE THAT IS REAL AND IS NAMED RATHER THAN HIDDEN: pinned compiles the pattern with the
// JavaScript engine (`new RegExp(pattern, 'i')`), GoTavern with Go's RE2 (`regexp.Compile`). A pattern
// RE2 rejects (backreferences, lookaround) throws in neither implementation — pinned logs
// `[Cache Buster] Invalid user agent pattern:` and keeps a null regex, which means "bust every agent",
// and so does this one — but a pattern JS rejects and RE2 accepts would behave differently. No such
// pattern is known, and the fallback direction is identical for the invalid case.

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"regexp"
	"sync"

	"github.com/cocokoishi/gotavern/internal/commandline"
)

// pinnedDefaultUserHandle is DEFAULT_USER.handle (src/constants.js:55). Pinned falls back to it when
// there is no authenticated user, which is the state of every request when accounts are disabled.
const pinnedDefaultUserHandle = "default-user"

// pinnedClearSiteDataValue is the exact header value from src/middleware/cacheBuster.js:103, quotes
// included.
const pinnedClearSiteDataValue = `"cache"`

// cacheBuster is the process-wide state of the pinned middleware singleton: the resolved config, the
// compiled pattern and the set of (handle, user-agent-hash) keys already consumed.
type cacheBuster struct {
	enabled bool
	pattern *regexp.Regexp

	mu   sync.Mutex
	keys map[string]struct{}
}

// newCacheBuster builds the singleton from the resolved cacheBuster.* configuration. A pattern that
// cannot be compiled leaves the buster with no pattern, which means "bust every agent" — the same
// state pinned ends up in after logging `[Cache Buster] Invalid user agent pattern:`.
func newCacheBuster(settings commandline.CacheBusterSettings) *cacheBuster {
	buster := &cacheBuster{enabled: settings.Enabled, keys: make(map[string]struct{})}
	if settings.UserAgentPattern != "" {
		// The pinned flag is 'i' (cacheBuster.js:32): the pattern is matched case-insensitively.
		if compiled, err := regexp.Compile("(?i)" + settings.UserAgentPattern); err == nil {
			buster.pattern = compiled
		}
	}
	return buster
}

// bust is pinned's `bust` (cacheBuster.js:101-105): set `Clear-Site-Data: "cache"` when the buster is
// enabled and the request's user agent matches the configured pattern. It is NOT once-per-key; the
// three image-replacement routes call it on every successful write.
func (buster *cacheBuster) bust(w http.ResponseWriter, request *http.Request) {
	if buster == nil || !buster.enabled {
		return
	}
	if buster.pattern != nil && !buster.pattern.MatchString(request.Header.Get("User-Agent")) {
		return
	}
	w.Header().Set("Clear-Site-Data", pinnedClearSiteDataValue)
}

// handleIndex is pinned's `#middleware` (cacheBuster.js:72-85) for the host index page: the header is
// set at most once per (handle, sha256(user-agent)) pair for the lifetime of the process.
func (buster *cacheBuster) handleIndex(w http.ResponseWriter, request *http.Request, handle string) {
	if buster == nil {
		return
	}
	if handle == "" {
		handle = pinnedDefaultUserHandle
	}
	// `crypto.createHash('sha256').update(userAgent).digest('hex')` — the digest is over the UTF-8
	// bytes of the user agent, and an absent header is the empty string, not a missing key.
	digest := sha256.Sum256([]byte(request.Header.Get("User-Agent")))
	key := handle + "-" + hex.EncodeToString(digest[:])

	buster.mu.Lock()
	if _, consumed := buster.keys[key]; consumed {
		buster.mu.Unlock()
		return
	}
	// Consumed BEFORE the header decision, in pinned's order (cacheBuster.js:82-83).
	buster.keys[key] = struct{}{}
	buster.mu.Unlock()

	buster.bust(w, request)
}

// isPinnedIndexRequest reports whether the request is one pinned's `app.get('/')` route would handle.
// Express adds an automatic HEAD handler for every GET route (express/lib/router/route.js:83-85) and
// Route.prototype._handles_method falls back from 'head' to 'get' (:68), so HEAD / runs the middleware
// too; nothing else does, because the buster is mounted on that one route and not app-wide.
func isPinnedIndexRequest(request *http.Request) bool {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		return false
	}
	return request.URL.Path == "/"
}

// requestAccountHandle resolves the handle the pinned middleware keys on:
// `request.user?.profile?.handle || DEFAULT_USER.handle`. GoTavern's equivalent of `request.user` is the
// account resolved earlier in the middleware chain; a missing account or a missing handle falls back to
// the pinned default, exactly as `||` does.
func requestAccountHandle(user *storedAccount) string {
	if user == nil {
		return pinnedDefaultUserHandle
	}
	if handle := user.string("handle"); handle != "" {
		return handle
	}
	return pinnedDefaultUserHandle
}
