// Package server contains the HTTP behavior implemented against the pinned
// SillyTavern reference. It deliberately exposes only routes with an oracle
// capture; the rest of the API remains unimplemented.
package server

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/upstream"
)

const (
	upstreamAgent      = "SillyTavern:1.19.0:Cohee#1207"
	upstreamRevision   = "06bde939f"
	upstreamBranch     = "release"
	upstreamCommitDate = "2026-09-14 21:01:34 +0200"
)

type versionResponse struct {
	Agent       string `json:"agent"`
	PkgVersion  string `json:"pkgVersion"`
	GitRevision string `json:"gitRevision"`
	GitBranch   string `json:"gitBranch"`
	CommitDate  string `json:"commitDate"`
	IsLatest    bool   `json:"isLatest"`
}

// HTTPHandlerOptions selects the startup-derived behavior used by the pinned
// HTTP middleware. A nil session timeout means SillyTavern's default of -1
// (400 days).
type HTTPHandlerOptions struct {
	InstallRoot                string
	DataRoot                   string
	CookieSecret               string
	DisableCSRF                bool
	EnableCorsProxy            bool
	WhitelistEnabled           bool
	ForwardedWhitelist         bool
	Whitelist                  []string
	ForbiddenPage              []byte
	PreserveForbiddenPage      bool
	HostWhitelistEnabled       bool
	HostWhitelistScan          bool
	HostWhitelistHosts         []string
	hostWhitelistWarningWriter io.Writer
	BasicAuthEnabled           bool
	BasicAuthMode              bool
	PerUserBasicAuth           bool
	BasicAuthUsername          any
	BasicAuthPassword          any
	BasicAuthRateLimit         *float64
	AccountsEnabled            bool
	DiscreetLogin              bool
	PreferRealIPHeader         bool
	SkipContentCheck           bool
	AllowFullDataBackup        *bool
	AllowKeysExposure          bool
	SettingsBackupRetention    *float64
	ExtensionsEnabled          *bool
	ExtensionsAutoUpdate       *bool
	RequestCompressionEnabled  *bool
	RequestCompressionMin      any
	RequestCompressionMax      any
	RequestCompressionTimeout  any
	LoginRateLimitPoints       *float64
	RecoveryRateLimitPoints    *float64
	ResetRateLimitPoints       *float64
	recoveryCodeGenerator      func() (string, error)
	resetCodeGenerator         func() (string, error)
	ForwardedXRealIP           *bool
	ForwardedCFConnectingIP    *bool
	ForwardedXForwardedFor     *bool
	SessionTimeoutSeconds      *float64
}

// HTTPHandlerOptionsFromCommandLine translates config-derived values used by
// the pinned Basic Auth, session, CSRF, and account middleware into handler options.
func HTTPHandlerOptionsFromCommandLine(parsed commandline.CommandLineResult) HTTPHandlerOptions {
	settings := parsed.StartupSettings
	options := HTTPHandlerOptions{
		DataRoot:              parsed.Paths.RuntimeDataRoot,
		DisableCSRF:           optionBoolean(parsed.Options.DisableCsrf),
		EnableCorsProxy:       optionBoolean(parsed.Options.EnableCorsProxy),
		WhitelistEnabled:      optionBoolean(parsed.Options.WhitelistMode),
		ForwardedWhitelist:    optionBoolean(settings.EnableForwardedWhitelist),
		Whitelist:             stringList(settings.Whitelist),
		HostWhitelistEnabled:  optionBoolean(settings.HostWhitelistEnabled),
		HostWhitelistScan:     optionBoolean(settings.HostWhitelistScan),
		HostWhitelistHosts:    stringList(settings.HostWhitelistHosts),
		BasicAuthEnabled:      optionBoolean(parsed.Options.Listen) && optionBoolean(parsed.Options.BasicAuthMode),
		BasicAuthMode:         optionBoolean(parsed.Options.BasicAuthMode),
		PerUserBasicAuth:      optionBoolean(settings.PerUserBasicAuth),
		BasicAuthUsername:     settings.BasicAuthUsername,
		BasicAuthPassword:     settings.BasicAuthPassword,
		AccountsEnabled:       optionBoolean(settings.EnableUserAccounts),
		DiscreetLogin:         optionBoolean(settings.EnableDiscreetLogin),
		PreferRealIPHeader:    optionBoolean(settings.PreferRealIPHeader),
		SkipContentCheck:      optionBoolean(settings.SkipContentCheck),
		AllowKeysExposure:     optionBoolean(settings.AllowKeysExposure),
		RequestCompressionMin: settings.RequestCompressionMin,
		RequestCompressionMax: settings.RequestCompressionMax,
	}
	if enabled, ok := optionBooleanValue(settings.ExtensionsEnabled); ok {
		options.ExtensionsEnabled = &enabled
	}
	if enabled, ok := optionBooleanValue(settings.ExtensionsAutoUpdate); ok {
		options.ExtensionsAutoUpdate = &enabled
	}
	if enabled, ok := optionBooleanValue(settings.RequestCompressionEnabled); ok {
		options.RequestCompressionEnabled = &enabled
	}
	if timeout, ok := optionNumber(settings.RequestCompressionTimeout); ok {
		options.RequestCompressionTimeout = timeout
	}
	if timeout, ok := optionNumber(settings.SessionTimeout); ok {
		options.SessionTimeoutSeconds = &timeout
	}
	if attempts, ok := optionNumber(settings.AccountsLoginMaxAttempts); ok {
		options.LoginRateLimitPoints = &attempts
	}
	if attempts, ok := optionNumber(settings.AccountsRecoverMaxAttempts); ok {
		options.RecoveryRateLimitPoints = &attempts
	}
	if attempts, ok := optionNumber(settings.AccountsResetMaxAttempts); ok {
		options.ResetRateLimitPoints = &attempts
	}
	if allowed, ok := optionBooleanValue(settings.AllowFullDataBackup); ok {
		options.AllowFullDataBackup = &allowed
	}
	if retention, ok := optionNumber(settings.SettingsBackupRetention); ok {
		options.SettingsBackupRetention = &retention
	}
	if attempts, ok := optionNumber(settings.BasicAuthMaxAttempts); ok {
		options.BasicAuthRateLimit = &attempts
	}
	if enabled, ok := optionBooleanValue(settings.ForwardedXRealIP); ok {
		options.ForwardedXRealIP = &enabled
	}
	if enabled, ok := optionBooleanValue(settings.ForwardedCFConnectingIP); ok {
		options.ForwardedCFConnectingIP = &enabled
	}
	if enabled, ok := optionBooleanValue(settings.ForwardedXForwardedFor); ok {
		options.ForwardedXForwardedFor = &enabled
	}
	return options
}

func optionBoolean(value any) bool {
	result, _ := optionBooleanValue(value)
	return result
}

func optionBooleanValue(value any) (bool, bool) {
	switch typed := value.(type) {
	case nil:
		return false, false
	case bool:
		return typed, true
	case string:
		return typed != "", true
	case int:
		return typed != 0, true
	case int64:
		return typed != 0, true
	case float64:
		return typed != 0, true
	default:
		return true, true
	}
}

func optionNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case float64:
		return typed, true
	default:
		return 0, false
	}
}

func stringList(value any) []string {
	var result []string
	switch values := value.(type) {
	case []any:
		for _, item := range values {
			if text, ok := item.(string); ok {
				result = append(result, text)
			}
		}
	case []string:
		result = append(result, values...)
	}
	return result
}

// NewHTTPHandler serves asset and HTTP behavior that does not require startup
// state. Session routes should use NewHTTPHandlerWithOptions after startup has
// initialized the cookie secret in the data root.
func NewHTTPHandler() http.Handler {
	page, err := upstream.Assets.ReadFile("default/content/errors/url-not-found.html")
	if err != nil {
		page = nil
	}
	return newHTTPHandler(page, HTTPHandlerOptions{})
}

// NewHTTPHandlerWithDataRoot reads the custom 404 page and cookie secret once
// when the handler is constructed. Other server settings use pinned defaults.
func NewHTTPHandlerWithDataRoot(dataRoot string) http.Handler {
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: dataRoot})
}

// NewHTTPHandlerWithOptions reads the cookie secret and custom error page from
// the initialized data root. The caller is responsible for running pinned
// startup first, including cookie-secret creation and configuration parsing.
func NewHTTPHandlerWithOptions(options HTTPHandlerOptions) http.Handler {
	var page []byte
	forbiddenPage := options.ForbiddenPage
	if options.DataRoot != "" {
		page, _ = os.ReadFile(filepath.Join(options.DataRoot, "_errors", "url-not-found.html"))
		if !options.PreserveForbiddenPage {
			forbiddenPage, _ = os.ReadFile(filepath.Join(options.DataRoot, "_errors", "forbidden-by-whitelist.html"))
		}
	} else {
		page, _ = upstream.Assets.ReadFile("default/content/errors/url-not-found.html")
		if !options.PreserveForbiddenPage {
			forbiddenPage, _ = upstream.Assets.ReadFile("default/content/errors/forbidden-by-whitelist.html")
		}
	}
	options.ForbiddenPage = forbiddenPage
	if options.CookieSecret == "" && options.DataRoot != "" {
		secret, _ := os.ReadFile(filepath.Join(options.DataRoot, "cookie-secret.txt"))
		options.CookieSecret = string(secret)
	}
	return newHTTPHandler(page, options)
}

func newHTTPHandler(notFoundPage []byte, options HTTPHandlerOptions) http.Handler {
	accounts := newAccountRuntime(options)
	basicAuth := newBasicAuthRuntime(options)
	hostWhitelist := newHostWhitelistRuntime(options)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /version", serveVersion)
	mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
		accounts.serveLoginPage(w, r)
	})
	mux.HandleFunc("GET /csrf-token", func(w http.ResponseWriter, r *http.Request) {
		serveCSRFToken(w, r, options)
	})
	mux.HandleFunc("POST /api/users/list", accounts.serveUserList)
	mux.HandleFunc("POST /api/users/login", accounts.serveUserLogin)
	mux.HandleFunc("POST /api/users/logout", accounts.serveUserLogout)
	mux.HandleFunc("GET /api/users/me", accounts.serveUserMe)
	mux.HandleFunc("POST /api/users/change-avatar", accounts.serveUserChangeAvatar)
	mux.HandleFunc("POST /api/users/change-name", accounts.serveUserChangeName)
	mux.HandleFunc("POST /api/users/change-password", accounts.serveUserChangePassword)
	mux.HandleFunc("POST /api/users/backup", accounts.serveUserBackup)
	mux.HandleFunc("POST /api/users/reset-settings", accounts.serveUserResetSettings)
	mux.HandleFunc("POST /api/users/reset-step1", accounts.serveUserResetStep1)
	mux.HandleFunc("POST /api/users/reset-step2", accounts.serveUserResetStep2)
	mux.HandleFunc("POST /api/users/get", accounts.serveUserAdminGet)
	mux.HandleFunc("POST /api/users/create", accounts.serveUserAdminCreate)
	mux.HandleFunc("POST /api/users/slugify", accounts.serveUserAdminSlugify)
	mux.HandleFunc("POST /api/users/disable", accounts.serveUserAdminDisable)
	mux.HandleFunc("POST /api/users/enable", accounts.serveUserAdminEnable)
	mux.HandleFunc("POST /api/users/promote", accounts.serveUserAdminPromote)
	mux.HandleFunc("POST /api/users/demote", accounts.serveUserAdminDemote)
	mux.HandleFunc("POST /api/users/delete", accounts.serveUserAdminDelete)
	mux.HandleFunc("POST /api/users/recover-step1", accounts.serveUserRecoverStep1)
	mux.HandleFunc("POST /api/users/recover-step2", accounts.serveUserRecoverStep2)
	mux.HandleFunc("POST /api/settings/get-snapshots", accounts.serveSettingsGetSnapshots)
	mux.HandleFunc("POST /api/settings/get", accounts.serveSettingsGet)
	mux.HandleFunc("POST /api/settings/save", accounts.serveSettingsSave)
	mux.HandleFunc("POST /api/settings/load-snapshot", accounts.serveSettingsLoadSnapshot)
	mux.HandleFunc("POST /api/settings/make-snapshot", accounts.serveSettingsMakeSnapshot)
	mux.HandleFunc("POST /api/settings/restore-snapshot", accounts.serveSettingsRestoreSnapshot)
	mux.HandleFunc("POST /api/quick-replies/save", accounts.serveQuickReplySave)
	mux.HandleFunc("POST /api/quick-replies/delete", accounts.serveQuickReplyDelete)
	mux.HandleFunc("POST /api/themes/save", accounts.serveThemeSave)
	mux.HandleFunc("POST /api/themes/delete", accounts.serveThemeDelete)
	mux.HandleFunc("POST /api/moving-ui/save", accounts.serveMovingUISave)
	mux.HandleFunc("POST /api/avatars/get", accounts.serveAvatarsGet)
	mux.HandleFunc("POST /api/avatars/delete", accounts.serveAvatarsDelete)
	mux.HandleFunc("/api/backgrounds/folders", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveBackgroundFolders(w, r)
	})
	mux.HandleFunc("/api/image-metadata/folders/get", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveImageMetadataFoldersGet(w, r)
	})
	mux.HandleFunc("/api/image-metadata/all", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveImageMetadataAll(w, r)
	})
	mux.HandleFunc("/api/image-metadata/folders/create", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveImageMetadataFolderCreate(w, r)
	})
	mux.HandleFunc("GET /api/sprites/get", accounts.serveSpritesGet)
	mux.HandleFunc("POST /api/sprites/delete", accounts.serveSpritesDelete)
	mux.HandleFunc("/savetheme", func(w http.ResponseWriter, r *http.Request) {
		serveRedirect(w, r, http.StatusPermanentRedirect, "/api/themes/save")
	})
	mux.HandleFunc("/savemovingui", func(w http.ResponseWriter, r *http.Request) {
		serveRedirect(w, r, http.StatusPermanentRedirect, "/api/moving-ui/save")
	})
	mux.HandleFunc("/getuseravatars", func(w http.ResponseWriter, r *http.Request) {
		serveRedirect(w, r, http.StatusPermanentRedirect, "/api/avatars/get")
	})
	mux.HandleFunc("/deleteuseravatar", func(w http.ResponseWriter, r *http.Request) {
		serveRedirect(w, r, http.StatusPermanentRedirect, "/api/avatars/delete")
	})
	mux.HandleFunc("/savequickreply", func(w http.ResponseWriter, r *http.Request) {
		serveRedirect(w, r, http.StatusPermanentRedirect, "/api/quick-replies/save")
	})
	mux.HandleFunc("/deletequickreply", func(w http.ResponseWriter, r *http.Request) {
		serveRedirect(w, r, http.StatusPermanentRedirect, "/api/quick-replies/delete")
	})
	mux.HandleFunc("POST /api/ping", func(w http.ResponseWriter, r *http.Request) {
		servePing(w, r, options)
	})
	mux.HandleFunc("GET /callback", func(w http.ResponseWriter, r *http.Request) {
		serveCallback(w, r, notFoundPage)
	})
	mux.HandleFunc("GET /callback/", func(w http.ResponseWriter, r *http.Request) {
		serveCallback(w, r, notFoundPage)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		serveStatic(w, r, notFoundPage, options)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setPinnedSecurityHeaders(w.Header())
		if options.BasicAuthEnabled && !basicAuth.authenticate(w, r, options) {
			return
		}
		if options.WhitelistEnabled {
			allowed, ipDetails := requestPassesWhitelist(r, options)
			if !allowed {
				serveWhitelistForbidden(w, r, options.ForbiddenPage, ipDetails)
				return
			}
		}
		if !hostWhitelist.allow(w, r) {
			return
		}
		var session *cookieSession
		if options.AccountsEnabled || (r.URL.Path == "/csrf-token" && r.Method == http.MethodGet) || (r.Method == http.MethodPost && (r.URL.Path == "/api/users/logout" || r.URL.Path == "/api/users/change-password")) || (!options.DisableCSRF && requiresCSRFSynchronization(r, options)) {
			session = loadCookieSession(r, options)
			r = r.WithContext(withSession(r.Context(), session))
		}
		var user *storedAccount
		if options.AccountsEnabled {
			var invalidated bool
			var err error
			user, invalidated, err = accounts.currentUser(session)
			if err != nil {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			if invalidated {
				clearCookieSession(w, r, options)
				serveStatusText(w, http.StatusForbidden)
				return
			}
			if user != nil && r.Method == http.MethodGet && r.URL.Path == "/" {
				session.set("touch", time.Now().UnixMilli())
			}
		} else {
			user = &accounts.defaultUser
		}
		r = withAccountState(r, accountRequestState{session: session, user: user})
		if session != nil && session.shouldWrite() && r.URL.Path != "/csrf-token" {
			writeCookieSession(w, r, options, session)
		}
		if r.URL.Path == "/csrf-token" && r.Method == http.MethodGet {
			if options.DisableCSRF {
				serveDisabledCSRFToken(w, r)
				return
			}
		}
		if !options.DisableCSRF && requiresCSRFSynchronization(r, options) {
			storedToken, hasStoredToken := session.stringValue("csrfToken")
			requestToken, hasRequestToken := csrfTokenFromHeader(r)
			if !hasStoredToken || !hasRequestToken || requestToken != storedToken {
				serveInvalidCSRFToken(w)
				return
			}
		}
		if options.AccountsEnabled && !isPublicAccountRequest(r) && user == nil {
			serveStatusText(w, http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func setPinnedSecurityHeaders(header http.Header) {
	header.Set("Cross-Origin-Opener-Policy", "same-origin")
	header.Set("Cross-Origin-Resource-Policy", "same-origin")
	header.Set("Origin-Agent-Cluster", "?1")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-DNS-Prefetch-Control", "off")
	header.Set("X-Download-Options", "noopen")
	header.Set("X-Frame-Options", "SAMEORIGIN")
	header.Set("X-Permitted-Cross-Domain-Policies", "none")
	header.Set("X-XSS-Protection", "0")
	header.Set("Vary", "Origin, Accept-Encoding")
}

func serveCallback(w http.ResponseWriter, r *http.Request, notFoundPage []byte) {
	escapedPath := r.URL.EscapedPath()
	var source string
	switch {
	case escapedPath == "/callback" || escapedPath == "/callback/":
	case strings.HasPrefix(escapedPath, "/callback/"):
		rawSource := strings.TrimPrefix(escapedPath, "/callback/")
		if rawSource == "" || strings.Contains(rawSource, "/") {
			serveNotFound(w, r, notFoundPage)
			return
		}
		decoded, err := url.PathUnescape(rawSource)
		if err != nil {
			serveNotFound(w, r, notFoundPage)
			return
		}
		source = decoded
	default:
		serveNotFound(w, r, notFoundPage)
		return
	}

	params := make([]string, 0, 2)
	if source != "" {
		params = append(params, "source="+urlSearchParamEscape(source))
	}
	if r.URL.RawQuery != "" {
		params = append(params, "query="+urlSearchParamEscape(r.URL.RawQuery))
	}
	serveRedirect(w, r, http.StatusTemporaryRedirect, "/?"+strings.Join(params, "&"))
}

func serveDisabledAccountsLogin(w http.ResponseWriter, r *http.Request) {
	serveRedirect(w, r, http.StatusFound, "/")
}

func serveRedirect(w http.ResponseWriter, r *http.Request, status int, location string) {
	message := http.StatusText(status) + ". Redirecting to " + location
	contentType := "text/plain; charset=utf-8"
	body := message
	if acceptsHTMLRedirect(r.Header.Get("Accept")) {
		contentType = "text/html; charset=utf-8"
		body = "<p>" + html.EscapeString(message) + "</p>"
	}
	w.Header().Set("Location", location)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.Header().Set("Vary", "Origin, Accept, Accept-Encoding")
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(body))
	}
}

func urlSearchParamEscape(value string) string {
	encoded := url.QueryEscape(value)
	encoded = strings.ReplaceAll(encoded, "~", "%7E")
	return strings.ReplaceAll(encoded, "%2A", "*")
}

func acceptsHTMLRedirect(accept string) bool {
	for _, mediaRange := range strings.Split(accept, ",") {
		mediaType, parameters, err := mime.ParseMediaType(strings.TrimSpace(mediaRange))
		if err != nil || mediaType != "text/html" {
			continue
		}
		quality := 1.0
		if value, ok := parameters["q"]; ok {
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil {
				quality = 0
			} else {
				quality = parsed
			}
		}
		return quality > 0
	}
	return false
}

func serveVersion(w http.ResponseWriter, r *http.Request) {
	body, err := json.Marshal(versionResponse{
		Agent:       upstreamAgent,
		PkgVersion:  upstream.SillyTavernVersion,
		GitRevision: upstreamRevision,
		GitBranch:   upstreamBranch,
		CommitDate:  upstreamCommitDate,
		IsLatest:    true,
	})
	if err != nil {
		http.Error(w, "version response unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func serveStatic(w http.ResponseWriter, r *http.Request, notFoundPage []byte, options HTTPHandlerOptions) {
	if options.AccountsEnabled && r.URL.Path == "/" && accountFromContext(r).user == nil {
		location := "/login"
		if r.URL.RawQuery != "" {
			location += "?" + r.URL.RawQuery
		}
		serveRedirect(w, r, http.StatusFound, location)
		return
	}
	assetPath := strings.TrimPrefix(r.URL.Path, "/")
	if assetPath == "" {
		assetPath = "index.html"
	}
	assetPath = path.Clean(assetPath)
	if assetPath == "." || assetPath == ".." || strings.HasPrefix(assetPath, "../") || strings.HasPrefix(assetPath, "/") {
		serveNotFound(w, r, notFoundPage)
		return
	}

	root := "public"
	if assetPath == "lib.js" {
		root = "generated"
	} else if !fsPathIsValid(assetPath) {
		serveNotFound(w, r, notFoundPage)
		return
	}

	body, err := upstream.Assets.ReadFile(root + "/" + assetPath)
	if err != nil {
		serveNotFound(w, r, notFoundPage)
		return
	}
	w.Header().Set("Content-Type", staticContentType(assetPath))
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func serveNotFound(w http.ResponseWriter, r *http.Request, page []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(page)))
	w.Header().Set("ETag", expressWeakETag(page))
	w.WriteHeader(http.StatusNotFound)
	if r.Method != http.MethodHead {
		_, _ = w.Write(page)
	}
}

func expressWeakETag(body []byte) string {
	digest := sha1.Sum(body)
	encoded := base64.StdEncoding.EncodeToString(digest[:])
	return fmt.Sprintf("W/\"%x-%s\"", len(body), encoded[:27])
}

func fsPathIsValid(p string) bool {
	return p != "" && p != "." && !strings.HasPrefix(p, "../") && !strings.HasPrefix(p, "/")
}

func staticContentType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".html", ".htm":
		return "text/html; charset=UTF-8"
	case ".js", ".mjs":
		return "application/javascript; charset=UTF-8"
	case ".css":
		return "text/css; charset=UTF-8"
	case ".json":
		return "application/json; charset=utf-8"
	default:
		if contentType := mime.TypeByExtension(path.Ext(name)); contentType != "" {
			return contentType
		}
		return "application/octet-stream"
	}
}
