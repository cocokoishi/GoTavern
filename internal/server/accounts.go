package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cocokoishi/gotavern/upstream"
	"golang.org/x/crypto/scrypt"
	"golang.org/x/crypto/sha3"
	"golang.org/x/text/unicode/norm"
)

const (
	userStorageFolder   = "_storage"
	userStoragePrefix   = "user:"
	avatarStoragePrefix = "avatar:"
	publicUserAvatar    = "/img/default-user.png"
)

type storedAccount struct {
	fields map[string]json.RawMessage
}

type nodeStorageRecord struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

type publicUser struct {
	Handle   json.RawMessage `json:"handle,omitempty"`
	Name     json.RawMessage `json:"name,omitempty"`
	Created  json.RawMessage `json:"created,omitempty"`
	Avatar   string          `json:"avatar"`
	Password bool            `json:"password"`
}

type accountRequestContextKey struct{}

type accountRequestState struct {
	session *cookieSession
	user    *storedAccount
}

type accountRuntime struct {
	options HTTPHandlerOptions
	limiter *memoryLoginLimiter
}

type loginAttemptWindow struct {
	consumed int
	resetAt  time.Time
}

type memoryLoginLimiter struct {
	mu       sync.Mutex
	points   float64
	duration time.Duration
	entries  map[string]loginAttemptWindow
}

func newAccountRuntime(options HTTPHandlerOptions) *accountRuntime {
	points := float64(5)
	if options.LoginRateLimitPoints != nil {
		points = *options.LoginRateLimitPoints
	}
	if points <= 0 {
		points = 9007199254740991
	}
	return &accountRuntime{
		options: options,
		limiter: &memoryLoginLimiter{points: points, duration: time.Minute, entries: make(map[string]loginAttemptWindow)},
	}
}

func (limiter *memoryLoginLimiter) consume(key string, now time.Time) (bool, time.Duration) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	window, found := limiter.entries[key]
	if !found || !now.Before(window.resetAt) {
		window = loginAttemptWindow{resetAt: now.Add(limiter.duration)}
	}
	window.consumed++
	limiter.entries[key] = window
	if float64(window.consumed) <= limiter.points {
		return true, 0
	}
	return false, max(window.resetAt.Sub(now), 0)
}

func (limiter *memoryLoginLimiter) clear(key string) {
	limiter.mu.Lock()
	delete(limiter.entries, key)
	limiter.mu.Unlock()
}

func loadStoredAccounts(dataRoot string) (map[string]storedAccount, error) {
	accounts := make(map[string]storedAccount)
	if dataRoot == "" {
		return accounts, nil
	}
	directory := filepath.Join(dataRoot, userStorageFolder)
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return accounts, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read user storage directory: %w", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") || !entry.Type().IsRegular() {
			continue
		}
		body, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read node-persist record %s: %w", entry.Name(), err)
		}
		var record nodeStorageRecord
		if err := json.Unmarshal(body, &record); err != nil {
			return nil, fmt.Errorf("decode node-persist record %s: %w", entry.Name(), err)
		}
		if !strings.HasPrefix(record.Key, userStoragePrefix) {
			continue
		}
		var fields map[string]json.RawMessage
		if len(record.Value) == 0 || json.Unmarshal(record.Value, &fields) != nil || fields == nil {
			continue
		}
		handle := strings.TrimPrefix(record.Key, userStoragePrefix)
		accounts[handle] = storedAccount{fields: fields}
	}
	return accounts, nil
}

func (account storedAccount) raw(name string) json.RawMessage {
	return account.fields[name]
}

func (account storedAccount) string(name string) string {
	var value string
	if json.Unmarshal(account.raw(name), &value) == nil {
		return value
	}
	return ""
}

func (account storedAccount) version() string {
	var payload bytes.Buffer
	payload.WriteByte('[')
	for index, key := range []string{"handle", "password", "salt"} {
		if index > 0 {
			payload.WriteByte(',')
		}
		value := account.raw(key)
		if len(value) == 0 {
			payload.WriteString("null")
		} else {
			payload.Write(compactJSON(value))
		}
	}
	payload.WriteByte(']')
	shake := sha3.NewShake256()
	_, _ = shake.Write(payload.Bytes())
	digest := make([]byte, 8)
	_, _ = io.ReadFull(shake, digest)
	return hex.EncodeToString(digest)
}

func nodeTruthyJSON(raw json.RawMessage) bool {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return false
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return true
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0
	default:
		return true
	}
}

func accountFromContext(ctx *http.Request) accountRequestState {
	state, _ := ctx.Context().Value(accountRequestContextKey{}).(accountRequestState)
	return state
}

func withAccountState(request *http.Request, state accountRequestState) *http.Request {
	return request.WithContext(contextWithAccountState(request, state))
}

func contextWithAccountState(request *http.Request, state accountRequestState) context.Context {
	return context.WithValue(request.Context(), accountRequestContextKey{}, state)
}

func (runtime *accountRuntime) currentUser(session *cookieSession) (*storedAccount, bool, error) {
	if session == nil {
		return nil, false, nil
	}
	handle, hasHandle := session.stringValue("handle")
	if !hasHandle || handle == "" {
		return nil, false, nil
	}
	accounts, err := loadStoredAccounts(runtime.options.DataRoot)
	if err != nil {
		return nil, false, err
	}
	account, found := accounts[handle]
	if !found || !nodeTruthyJSON(account.raw("enabled")) {
		return nil, false, nil
	}
	version := account.version()
	if storedVersion, hasVersion := session.fields["version"]; hasVersion {
		expected, _ := json.Marshal(version)
		if !bytes.Equal(compactJSON(storedVersion), expected) {
			return nil, true, nil
		}
	} else {
		session.set("version", version)
	}
	return &account, false, nil
}

func (runtime *accountRuntime) serveLoginPage(w http.ResponseWriter, request *http.Request) {
	if !runtime.options.AccountsEnabled {
		serveDisabledAccountsLogin(w, request)
		return
	}
	queryValues, hasNoAuto := request.URL.Query()["noauto"]
	noAuto := hasNoAuto && len(queryValues) > 0 && queryValues[0] != ""
	if !noAuto {
		accounts, err := loadStoredAccounts(runtime.options.DataRoot)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if len(accounts) == 1 {
			for _, account := range accounts {
				if !nodeTruthyJSON(account.raw("password")) {
					state := accountFromContext(request)
					if state.session == nil || runtime.options.CookieSecret == "" {
						serveStatusText(w, http.StatusInternalServerError)
						return
					}
					state.session.set("handle", account.string("handle"))
					state.session.set("version", account.version())
					writeCookieSession(w, request, runtime.options, state.session)
					serveRedirect(w, request, http.StatusFound, "/")
					return
				}
			}
		}
	}
	serveStaticAsset(w, request, "login.html")
}

func isPublicAccountRequest(request *http.Request) bool {
	if request.Method == http.MethodGet {
		if request.URL.Path == "/" || request.URL.Path == "/login" || request.URL.Path == "/csrf-token" {
			return true
		}
		if request.URL.Path == "/callback" || strings.HasPrefix(request.URL.Path, "/callback/") {
			return true
		}
	}
	if request.Method == http.MethodPost {
		switch request.URL.Path {
		case "/api/users/list", "/api/users/login", "/api/users/recover-step1", "/api/users/recover-step2":
			return true
		}
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		return false
	}
	assetPath := strings.TrimPrefix(request.URL.Path, "/")
	if assetPath == "" {
		return true
	}
	if assetPath == "lib.js" {
		_, err := upstream.Assets.ReadFile("generated/lib.js")
		return err == nil
	}
	clean := path.Clean(assetPath)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "\\") {
		return false
	}
	_, err := upstream.Assets.ReadFile("public/" + clean)
	return err == nil
}

func clearCookieSession(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	name := sessionCookieName()
	attributes := "; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=lax; httponly"
	if request.TLS != nil {
		attributes += "; secure"
	}
	w.Header().Add("Set-Cookie", name+"="+attributes)
	w.Header().Add("Set-Cookie", name+".sig="+keygripSign(options.CookieSecret, name+"=")+attributes)
}

func serveStaticAsset(w http.ResponseWriter, request *http.Request, name string) {
	body, err := upstream.Assets.ReadFile("public/" + name)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", staticContentType(name))
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "public, max-age=0")
	w.WriteHeader(http.StatusOK)
	if request.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func (runtime *accountRuntime) serveUserList(w http.ResponseWriter, request *http.Request) {
	if runtime.options.DiscreetLogin {
		serveStatusText(w, http.StatusNoContent)
		return
	}
	accounts, err := loadStoredAccounts(runtime.options.DataRoot)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	users := make([]storedAccount, 0, len(accounts))
	for _, account := range accounts {
		if nodeTruthyJSON(account.raw("enabled")) {
			users = append(users, account)
		}
	}
	sort.SliceStable(users, func(i, j int) bool {
		left := jsNumericValue(users[i].raw("created"))
		right := jsNumericValue(users[j].raw("created"))
		if left == right || left != left || right != right {
			return false
		}
		return left < right
	})
	viewModels := make([]publicUser, 0, len(users))
	for _, account := range users {
		viewModels = append(viewModels, publicUser{
			Handle:   account.raw("handle"),
			Name:     account.raw("name"),
			Created:  account.raw("created"),
			Avatar:   runtime.userAvatar(account),
			Password: nodeTruthyJSON(account.raw("password")),
		})
	}
	respondJSON(w, http.StatusOK, viewModels)
}

func jsNumericValue(raw json.RawMessage) float64 {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return 0
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return 0
	}
	switch typed := value.(type) {
	case float64:
		return typed
	case string:
		if typed == "" {
			return 0
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil {
			return parsed
		}
	}
	return 0
}

func (runtime *accountRuntime) userAvatar(account storedAccount) string {
	avatarKey := avatarStoragePrefix + account.string("handle")
	if runtime.options.DataRoot != "" {
		filename := filepath.Join(runtime.options.DataRoot, userStorageFolder, nodeStoreFilename(avatarKey))
		if body, err := os.ReadFile(filename); err == nil {
			var record nodeStorageRecord
			if json.Unmarshal(body, &record) == nil {
				var avatar string
				if json.Unmarshal(record.Value, &avatar) == nil && avatar != "" {
					return avatar
				}
			}
		}
	}
	if runtime.options.DataRoot != "" {
		settingsPath := filepath.Join(runtime.options.DataRoot, account.string("handle"), "settings.json")
		if body, err := os.ReadFile(settingsPath); err == nil {
			var settings map[string]any
			if json.Unmarshal(body, &settings) == nil {
				avatar := nestedString(settings, "power_user", "default_persona")
				if avatar == "" {
					avatar = nestedString(settings, "user_avatar")
				}
				if avatar != "" {
					fileName := filepath.Base(filepath.Clean(avatar))
					avatarPath := filepath.Join(runtime.options.DataRoot, account.string("handle"), "User Avatars", fileName)
					if body, err := os.ReadFile(avatarPath); err == nil {
						mediaType := mime.TypeByExtension(filepath.Ext(fileName))
						if mediaType == "" {
							mediaType = "application/octet-stream"
						}
						return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(body)
					}
				}
			}
		}
	}
	return publicUserAvatar
}

func nestedString(value map[string]any, keys ...string) string {
	for index, key := range keys {
		if index == len(keys)-1 {
			if result, ok := value[key].(string); ok {
				return result
			}
			return ""
		}
		nested, ok := value[key].(map[string]any)
		if !ok {
			return ""
		}
		value = nested
	}
	return ""
}

func nodeStoreFilename(key string) string {
	return fmt.Sprintf("%x", sha256Bytes([]byte(key)))
}

func sha256Bytes(value []byte) []byte {
	digest := sha256.Sum256(value)
	return digest[:]
}

func (runtime *accountRuntime) serveUserLogin(w http.ResponseWriter, request *http.Request) {
	var input map[string]json.RawMessage
	body, err := io.ReadAll(io.LimitReader(request.Body, 500<<20))
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if len(body) > 0 && json.Unmarshal(body, &input) != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if input == nil {
		input = make(map[string]json.RawMessage)
	}
	if !nodeTruthyJSON(input["handle"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	handle := jsonString(input["handle"])
	ip := runtime.clientIP(request)
	allowed, wait := runtime.limiter.consume(ip, time.Now())
	if !allowed {
		seconds := int64((wait + time.Second - 1) / time.Second)
		w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
		respondJSON(w, http.StatusTooManyRequests, map[string]string{"error": "Too many attempts. Try again later or recover your password."})
		return
	}
	accounts, err := loadStoredAccounts(runtime.options.DataRoot)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	account, found := accounts[handle]
	if !found {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "Incorrect credentials"})
		return
	}
	if !nodeTruthyJSON(account.raw("enabled")) {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "User is disabled"})
		return
	}
	password := jsonString(input["password"])
	storedPassword := account.raw("password")
	if nodeTruthyJSON(storedPassword) {
		storedHash := jsonString(storedPassword)
		salt := jsonString(account.raw("salt"))
		computedHash, err := upstreamPasswordHash(password, salt)
		if err != nil || subtle.ConstantTimeCompare([]byte(computedHash), []byte(storedHash)) != 1 {
			respondJSON(w, http.StatusForbidden, map[string]string{"error": "Incorrect credentials"})
			return
		}
	}
	state := accountFromContext(request)
	if state.session == nil || runtime.options.CookieSecret == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	runtime.limiter.clear(ip)
	state.session.set("handle", account.string("handle"))
	state.session.set("version", account.version())
	writeCookieSession(w, request, runtime.options, state.session)
	respondJSON(w, http.StatusOK, map[string]string{"handle": account.string("handle")})
}

func (runtime *accountRuntime) clientIP(request *http.Request) string {
	socketIP := socketIPAddress(request.RemoteAddr)
	if runtime.options.PreferRealIPHeader {
		if value := joinedHeaderValues(request, "X-Real-IP"); value != "" && forwardedHeaderEnabled(runtime.options.ForwardedXRealIP, true) {
			return socketIP + " (forwarded: " + value + ")"
		}
		if value := joinedHeaderValues(request, "CF-Connecting-IP"); value != "" && forwardedHeaderEnabled(runtime.options.ForwardedCFConnectingIP, false) {
			return socketIP + " (forwarded: " + value + ")"
		}
		if value := joinedHeaderValues(request, "X-Forwarded-For"); value != "" && forwardedHeaderEnabled(runtime.options.ForwardedXForwardedFor, true) {
			forwardedIP := strings.TrimSpace(strings.Split(value, ",")[0])
			if forwardedIP != "" {
				return socketIP + " (forwarded: " + forwardedIP + ")"
			}
		}
	}
	return socketIP
}

func socketIPAddress(remoteAddress string) string {
	if remoteAddress == "" {
		return "unknown"
	}
	host, _, err := net.SplitHostPort(remoteAddress)
	if err == nil {
		remoteAddress = host
	}
	parsed := net.ParseIP(remoteAddress)
	if parsed == nil {
		return remoteAddress
	}
	if ipv4 := parsed.To4(); ipv4 != nil {
		return ipv4.String()
	}
	return parsed.String()
}

func joinedHeaderValues(request *http.Request, header string) string {
	return strings.Join(request.Header.Values(header), ",")
}

func forwardedHeaderEnabled(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func upstreamPasswordHash(password, salt string) (string, error) {
	derived, err := scrypt.Key([]byte(norm.NFC.String(password)), []byte(salt), 1<<14, 8, 1, 64)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(derived), nil
}

func jsonString(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	return ""
}

func marshalNodeJSON(value any) ([]byte, error) {
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(body.Bytes(), []byte{'\n'}), nil
}

func respondJSON(w http.ResponseWriter, status int, value any) {
	body, err := marshalNodeJSON(value)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func serveStatusText(w http.ResponseWriter, status int) {
	if status == http.StatusNoContent || status == http.StatusNotModified {
		w.WriteHeader(status)
		return
	}
	body := []byte(http.StatusText(status))
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
