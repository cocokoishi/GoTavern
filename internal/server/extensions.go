package server

// Pinned frontend-extension management routes, from src/endpoints/extensions.js:
//
//	POST /api/extensions/install  extensions.js:92
//	POST /api/extensions/update   extensions.js:169
//	POST /api/extensions/branches extensions.js:217
//	POST /api/extensions/switch   extensions.js:266
//	POST /api/extensions/move     extensions.js:329
//	POST /api/extensions/version  extensions.js:387
//	POST /api/extensions/delete   extensions.js:442
//	GET  /api/extensions/discover extensions.js:480
//
// The whole router is wrapped in extensionsEnabledFeatureGuard
// (extensions.js:72-81), which answers 404 while `extensions.enabled` is false.
// In the pinned app that guard runs after the app-level login middleware
// (server-main.js:248 mounts requireLoginMiddleware, server-main.js:278 mounts
// the private routers), so an unauthenticated request is rejected by the login
// middleware first and never reaches the guard. GoTavern's account gate is also
// applied before the mux (http.go:543), and each handler below applies the
// feature guard after its account lookup, which keeps that ordering.
//
// Every route reads `request.body` through the app-level body-parser JSON
// middleware (server-main.js:110, limit 500mb), so readPinnedJSONBody is the
// same parser model the other user-data domains use.
//
// Known gaps, recorded in docs/compat-matrix.md:
//
//   - Pinned `PUBLIC_DIRECTORIES` are process-relative paths resolved against
//     the server working directory; GoTavern resolves them against
//     HTTPHandlerOptions.InstallRoot. For a normal install (server started from
//     the install root) the two agree.
//   - Pinned `/discover` returns `fs.readdirSync` order, which is a property of
//     the host filesystem (ext4 hash order, NTFS name order); GoTavern's
//     os.ReadDir sorts by name. The route's output is therefore compared as an
//     unordered set with the pinned grouping (system, local, global) preserved.
//   - GoTavern implements the pinned system-git backend only. The pinned
//     `git.backend: builtin` path (isomorphic-git, src/git/client.js:114-137) is
//     not implemented and answers 500 rather than silently using another
//     backend; a machine without a `git` binary in PATH therefore cannot
//     install or update extensions. This is a documented operational cost, not
//     a fabricated success.
//   - Express matches a trailing-slash request path while net/http's ServeMux
//     does not.
//   - A thrown route error answers with Express finalhandler's HTML page, whose
//     <pre> block is the V8 stack with host-absolute paths and pinned line
//     numbers; GoTavern answers the same status with serveStatusText.

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerExtensionsRoutes)
}

// pinnedExtensionServerErrorMessage is the body every pinned catch block sends
// with `response.status(500).send(...)` (extensions.js:154, 213, 262, 325, 373,
// 430, 472). Express writes it as text/html, which is why these are not
// serveStatusText responses.
const pinnedExtensionServerErrorMessage = "Internal Server Error. Check the server logs for more details."

func respondExtensionServerError(w http.ResponseWriter) {
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", pinnedExtensionServerErrorMessage)
}

// extensionsEnabled mirrors extensions.js:73. A nil option is the pinned
// default of true.
func extensionsEnabled(options HTTPHandlerOptions) bool {
	if options.ExtensionsEnabled == nil {
		return true
	}
	return *options.ExtensionsEnabled
}

func registerExtensionsRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	// extensions.js:81 applies the feature guard with router.use, before any
	// route matches, so the guard also answers the final 404 for a wrong method.
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if !extensionsEnabled(options) {
				serveStatusText(w, http.StatusNotFound)
				return
			}
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/extensions/install", accounts.serveExtensionInstall)
	post("/api/extensions/update", accounts.serveExtensionUpdate)
	post("/api/extensions/branches", accounts.serveExtensionBranches)
	post("/api/extensions/switch", accounts.serveExtensionSwitch)
	post("/api/extensions/move", accounts.serveExtensionMove)
	post("/api/extensions/version", accounts.serveExtensionVersion)
	post("/api/extensions/delete", accounts.serveExtensionDelete)

	mux.HandleFunc("/api/extensions/discover", func(w http.ResponseWriter, r *http.Request) {
		if !extensionsEnabled(options) {
			serveStatusText(w, http.StatusNotFound)
			return
		}
		if r.Method != http.MethodGet {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveExtensionDiscover(w, r)
	})
}

// pinnedExtensionsDirectory and pinnedGlobalExtensionsDirectory mirror
// src/constants.js:5-6. Node keeps them as paths relative to the process
// working directory, so the pinned routes embed those relative strings in their
// responses (`public/scripts/extensions/third-party/<name>`); GoTavern resolves
// the same relative layout against the install root for filesystem work but
// keeps the pinned relative string for anything a client can observe.
func pinnedExtensionsDirectory(options HTTPHandlerOptions) string {
	return filepath.Join(options.InstallRoot, pinnedExtensionsRelativePath())
}

func pinnedExtensionsRelativePath() string {
	return filepath.Join("public", "scripts", "extensions")
}

func pinnedGlobalExtensionsRelativePath() string {
	return filepath.Join(pinnedExtensionsRelativePath(), "third-party")
}

func pinnedGlobalExtensionsDirectory(options HTTPHandlerOptions) string {
	return filepath.Join(options.InstallRoot, pinnedGlobalExtensionsRelativePath())
}

// extensionLocation carries the pinned observable path next to the absolute
// path the filesystem work uses. For the user directory both are the same
// absolute path, which is what the pinned request.user.directories value is.
type extensionLocation struct {
	display  string
	resolved string
}

// extensionBaseLocation mirrors `global ? PUBLIC_DIRECTORIES.globalExtensions :
// request.user.directories.extensions`, which every route computes the same way.
func extensionBaseLocation(options HTTPHandlerOptions, directories startup.UserDirectories, global bool) extensionLocation {
	if global {
		relative := pinnedGlobalExtensionsRelativePath()
		return extensionLocation{display: relative, resolved: filepath.Join(options.InstallRoot, relative)}
	}
	userDirectory := directories["extensions"]
	return extensionLocation{display: userDirectory, resolved: userDirectory}
}

// extensionRequestLocation mirrors `source === 'global' ? ... : ...` in
// extensions.js:346-347. The pinned comparison is strict equality against the
// string 'global', so every other value (including other truthy values) selects
// the user directory.
func extensionRequestLocation(options HTTPHandlerOptions, directories startup.UserDirectories, value orderedNodeJSON) extensionLocation {
	return extensionBaseLocation(options, directories, value.kind == 's' && value.scalar.(string) == "global")
}

// extensionRequestBody reads the pinned body-parser result for one of these
// routes. A body that does not carry a JSON content type, and a zero-length
// body, both leave `request.body` as the empty object.
func extensionRequestBody(w http.ResponseWriter, request *http.Request) (orderedNodeJSON, bool) {
	body, ok := readPinnedJSONBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return orderedNodeJSON{}, false
	}
	return body, true
}

// extensionStringMember reproduces `typeof request.body.X !== 'string'`.
func extensionStringMember(body orderedNodeJSON, key string) (string, bool) {
	value, exists := body.member(key)
	if !exists || value.kind != 's' {
		return "", false
	}
	return value.scalar.(string), true
}

// extensionSanitizedName reproduces `sanitize(extensionName)` plus the
// `!extensionNameSanitized` rejection every route performs after it.
func extensionSanitizedName(body orderedNodeJSON) (string, bool) {
	name, isString := extensionStringMember(body, "extensionName")
	if !isString {
		return "", false
	}
	sanitized := startup.SanitizeUserFilename(name)
	if sanitized == "" {
		return "", false
	}
	return sanitized, true
}

// extensionAccount resolves the authenticated user, mirrors
// `request.user.directories`, and applies the extensions feature guard. The
// guard runs after authentication for the same reason it does upstream: the
// pinned login middleware is mounted before the private routers.
func (runtime *accountRuntime) extensionAccount(w http.ResponseWriter, request *http.Request) (*storedAccount, startup.UserDirectories, bool) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return nil, nil, false
	}
	if !extensionsEnabled(runtime.options) {
		serveStatusText(w, http.StatusNotFound)
		return nil, nil, false
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		respondExtensionServerError(w)
		return nil, nil, false
	}
	return account, directories, true
}

// extensionAccountIsAdmin mirrors `request.user.profile.admin` truthiness.
func extensionAccountIsAdmin(account *storedAccount) bool {
	return nodeTruthyJSON(account.raw("admin"))
}

// nodeBasenameExt mirrors Node's path.basename(file, ext) for the POSIX
// pathname produced by new URL(). The extension is stripped only when the
// basename is strictly longer than it, so basename('.git', '.git') stays '.git'
// and sanitize() then rejects it.
func nodeBasenameExt(name, ext string) string {
	if ext != "" && len(name) > len(ext) && strings.HasSuffix(name, ext) {
		return name[:len(name)-len(ext)]
	}
	return name
}

// nodeURLBasename mirrors path.basename(new URL(url).pathname). URL pathnames
// are POSIX and percent-encoded; Node never decodes them here.
func nodeURLBasename(pathname string) string {
	return path.Base(pathname)
}

// extensionManifest mirrors getManifest (extensions.js:24-34): the parsed
// manifest.json, or false when the file is missing or is not parsable JSON.
func extensionManifest(extensionPath string) (orderedNodeJSON, bool) {
	contents, err := os.ReadFile(filepath.Join(extensionPath, "manifest.json"))
	if err != nil {
		return orderedNodeJSON{}, false
	}
	manifest, err := decodeOrderedNodeJSON(contents)
	if err != nil {
		return orderedNodeJSON{}, false
	}
	return manifest, true
}

// removeExtensionTree mirrors `fs.promises.rm(path, { recursive: true })` for
// the delete route (no force) and `{ recursive: true, force: true }` for the
// install rollback.
func removeExtensionTree(target string, force bool) error {
	err := os.RemoveAll(target)
	if err == nil || force {
		return nil
	}
	return err
}

func extensionExists(target string) bool {
	_, err := os.Stat(target)
	return err == nil
}

func extensionIsDirectory(target string) bool {
	info, err := os.Stat(target)
	return err == nil && info.IsDir()
}

// ensureExtensionDirectory mirrors the pinned `if (!existsSync(p)) mkdirSync(p)`
// sequence: mkdirSync is not recursive, so a missing parent is an error.
func ensureExtensionDirectory(target string) error {
	if extensionExists(target) {
		return nil
	}
	err := os.Mkdir(target, 0o777)
	if err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	return nil
}
