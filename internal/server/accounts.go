package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
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

type accountMeViewModel struct {
	Handle   json.RawMessage `json:"handle,omitempty"`
	Name     json.RawMessage `json:"name,omitempty"`
	Avatar   string          `json:"avatar"`
	Admin    json.RawMessage `json:"admin,omitempty"`
	Password bool            `json:"password"`
	Created  json.RawMessage `json:"created,omitempty"`
}

type adminUserViewModel struct {
	Handle   json.RawMessage `json:"handle,omitempty"`
	Name     json.RawMessage `json:"name,omitempty"`
	Avatar   string          `json:"avatar"`
	Admin    json.RawMessage `json:"admin,omitempty"`
	Enabled  json.RawMessage `json:"enabled,omitempty"`
	Created  json.RawMessage `json:"created,omitempty"`
	Password bool            `json:"password"`
}

type accountRequestContextKey struct{}

type accountRequestState struct {
	session *cookieSession
	user    *storedAccount
}

type accountRuntime struct {
	options          HTTPHandlerOptions
	limiter          *memoryLoginLimiter
	recoverLimiter   *memoryLoginLimiter
	resetLimiter     *memoryLoginLimiter
	defaultUser      storedAccount
	createMu         sync.Mutex
	recoveryMu       sync.Mutex
	recoveryCodes    map[string]recoveryCodeEntry
	resetMu          sync.Mutex
	resetCodes       map[string]recoveryCodeEntry
	settingsSaveMu   sync.Mutex
	settingsSaves    map[string]*settingsSaveThrottle
	settingsSaveWait time.Duration
}

type recoveryCodeEntry struct {
	code    string
	expires time.Time
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
	recoverPoints := float64(5)
	if options.RecoveryRateLimitPoints != nil {
		recoverPoints = *options.RecoveryRateLimitPoints
	}
	if recoverPoints <= 0 {
		recoverPoints = 9007199254740991
	}
	resetPoints := float64(5)
	if options.ResetRateLimitPoints != nil {
		resetPoints = *options.ResetRateLimitPoints
	}
	if resetPoints <= 0 {
		resetPoints = 9007199254740991
	}
	defaultUser := storedAccount{fields: map[string]json.RawMessage{}}
	for key, value := range map[string]any{
		"handle":   "default-user",
		"name":     "User",
		"created":  time.Now().UnixMilli(),
		"password": "",
		"admin":    true,
		"enabled":  true,
		"salt":     "",
	} {
		encoded, _ := json.Marshal(value)
		defaultUser.fields[key] = encoded
	}
	return &accountRuntime{
		options:          options,
		limiter:          &memoryLoginLimiter{points: points, duration: time.Minute, entries: make(map[string]loginAttemptWindow)},
		recoverLimiter:   &memoryLoginLimiter{points: recoverPoints, duration: 5 * time.Minute, entries: make(map[string]loginAttemptWindow)},
		resetLimiter:     &memoryLoginLimiter{points: resetPoints, duration: 5 * time.Minute, entries: make(map[string]loginAttemptWindow)},
		defaultUser:      defaultUser,
		recoveryCodes:    make(map[string]recoveryCodeEntry),
		resetCodes:       make(map[string]recoveryCodeEntry),
		settingsSaves:    make(map[string]*settingsSaveThrottle),
		settingsSaveWait: 10 * time.Minute,
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

func (limiter *memoryLoginLimiter) exceeded(key string, now time.Time) (bool, time.Duration) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	window, found := limiter.entries[key]
	if !found || !now.Before(window.resetAt) || float64(window.consumed) <= limiter.points {
		return false, 0
	}
	return true, max(window.resetAt.Sub(now), 0)
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

func loadStoredAccount(dataRoot, handle string) (storedAccount, bool, error) {
	if dataRoot == "" {
		return storedAccount{}, false, nil
	}
	key := userStoragePrefix + handle
	body, err := os.ReadFile(filepath.Join(dataRoot, userStorageFolder, nodeStoreFilename(key)))
	if errors.Is(err, os.ErrNotExist) {
		return storedAccount{}, false, nil
	}
	if err != nil {
		return storedAccount{}, false, fmt.Errorf("read node-persist record %s: %w", key, err)
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(body, &record); err != nil || record == nil || !nodeTruthyJSON(record["key"]) {
		return storedAccount{}, false, fmt.Errorf("decode node-persist record %s: invalid storage file", key)
	}
	if !nodeTruthyJSON(record["value"]) {
		return storedAccount{}, false, nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(record["value"], &fields) != nil || fields == nil {
		// node-persist returns any truthy JSON value. JavaScript property access
		// then sees a missing handle/enabled field on primitives and arrays.
		fields = make(map[string]json.RawMessage)
	}
	return storedAccount{fields: fields}, true, nil
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
	account, found, err := loadStoredAccount(runtime.options.DataRoot, handle)
	if err != nil {
		return nil, false, err
	}
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
		state := accountFromContext(request)
		if runtime.options.BasicAuthMode && runtime.options.PerUserBasicAuth && state.user == nil {
			parts := strings.Split(request.Header.Get("Authorization"), " ")
			if len(parts) >= 2 && parts[0] == "Basic" && parts[1] != "" {
				username, password := decodeBasicCredentials(parts[1])
				if account, found := accounts[username]; found {
					matched, err := storedAccountMatchesBasicAuth(account, password)
					if err != nil {
						serveStatusText(w, http.StatusInternalServerError)
						return
					}
					if matched {
						if state.session == nil || runtime.options.CookieSecret == "" {
							serveStatusText(w, http.StatusInternalServerError)
							return
						}
						state.session.set("handle", username)
						state.session.set("version", account.version())
						writeCookieSession(w, request, runtime.options, state.session)
						serveRedirect(w, request, http.StatusFound, "/")
						return
					}
				}
			}
		}
	}
	serveStaticAsset(w, request, "login.html")
}

// isPublicAccountRequest reports whether a request may be answered without a
// session. It mirrors the pinned middleware order: the login page, the CSRF
// token, the callback and the account-recovery POSTs are public by route, and
// every other GET or HEAD is public exactly when the frontend static middleware
// would answer it — which is the same question the pinned express.static
// resolves before requireLoginMiddleware runs.
func isPublicAccountRequest(request *http.Request, options HTTPHandlerOptions) bool {
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
	return pinnedFrontendStaticServes(options, request)
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
	account, found, err := loadStoredAccount(runtime.options.DataRoot, handle)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
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

func (runtime *accountRuntime) serveUserRecoverStep1(w http.ResponseWriter, request *http.Request) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !nodeTruthyJSON(input["handle"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}

	ip := runtime.clientIP(request)
	allowed, wait := runtime.recoverLimiter.consume(ip, time.Now())
	if !allowed {
		serveAccountRateLimit(w, wait, "Too many attempts. Try again later or contact your admin.")
		return
	}
	handle := jsonString(input["handle"])
	account, found, err := loadStoredAccount(runtime.options.DataRoot, handle)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !found {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}
	if !nodeTruthyJSON(account.raw("enabled")) {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "User is disabled"})
		return
	}

	codeGenerator := runtime.options.recoveryCodeGenerator
	if codeGenerator == nil {
		codeGenerator = generateRecoveryCode
	}
	code, err := codeGenerator()
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	runtime.recoveryMu.Lock()
	runtime.recoveryCodes[account.string("handle")] = recoveryCodeEntry{code: code, expires: time.Now().Add(5 * time.Minute)}
	runtime.recoveryMu.Unlock()
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "%s, your password recovery code is: %s\n", account.string("name"), code)
	fmt.Fprintln(os.Stdout)
	serveNoContent(w)
}

func (runtime *accountRuntime) serveUserRecoverStep2(w http.ResponseWriter, request *http.Request) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !nodeTruthyJSON(input["handle"]) || !nodeTruthyJSON(input["code"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	handle := jsonString(input["handle"])
	account, found, err := loadStoredAccount(runtime.options.DataRoot, handle)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	ip := runtime.clientIP(request)
	if exceeded, wait := runtime.recoverLimiter.exceeded(ip, time.Now()); exceeded {
		serveAccountRateLimit(w, wait, "Too many attempts. Try again later or contact your admin.")
		return
	}
	if !found {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}
	if !nodeTruthyJSON(account.raw("enabled")) {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "User is disabled"})
		return
	}
	code := runtime.recoveryCode(account.string("handle"), time.Now())
	if requestCode := jsonString(input["code"]); requestCode != code || code == "" {
		allowed, wait := runtime.recoverLimiter.consume(ip, time.Now())
		if !allowed {
			serveAccountRateLimit(w, wait, "Too many attempts. Try again later or contact your admin.")
			return
		}
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "Incorrect code"})
		return
	}

	password := ""
	salt := ""
	if nodeTruthyJSON(input["newPassword"]) {
		if json.Unmarshal(input["newPassword"], &password) != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		saltBytes := make([]byte, 16)
		if _, err := rand.Read(saltBytes); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		salt = base64.StdEncoding.EncodeToString(saltBytes)
	}
	passwordHash := ""
	if password != "" {
		passwordHash, err = upstreamPasswordHash(password, salt)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	passwordJSON, _ := json.Marshal(passwordHash)
	saltJSON, _ := json.Marshal(salt)
	updatedAccount := storedAccount{}
	err = startup.UpdateNodePersistRecord(runtime.options.DataRoot, userStoragePrefix+account.string("handle"), func(current json.RawMessage) (json.RawMessage, error) {
		updatedValue, err := replaceJSONObjectMembers(current, []string{"password", "salt"}, map[string]json.RawMessage{
			"password": passwordJSON,
			"salt":     saltJSON,
		})
		if err != nil {
			return nil, err
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(updatedValue, &fields); err != nil || fields == nil {
			return nil, errors.New("updated user record is not a JSON object")
		}
		updatedAccount = storedAccount{fields: fields}
		return updatedValue, nil
	})
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	state := accountFromContext(request)
	if state.session != nil {
		if sessionHandle, hasHandle := state.session.stringValue("handle"); hasHandle && sessionHandle == account.string("handle") {
			state.session.set("version", updatedAccount.version())
			writeCookieSession(w, request, runtime.options, state.session)
		}
	}
	runtime.recoverLimiter.clear(ip)
	runtime.recoveryMu.Lock()
	delete(runtime.recoveryCodes, account.string("handle"))
	runtime.recoveryMu.Unlock()
	serveNoContent(w)
}

func (runtime *accountRuntime) serveUserMe(w http.ResponseWriter, request *http.Request) {
	state := accountFromContext(request)
	account := state.user
	if account == nil && !runtime.options.AccountsEnabled {
		account = &runtime.defaultUser
	}
	if account == nil {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	respondJSON(w, http.StatusOK, accountMeViewModel{
		Handle:   account.raw("handle"),
		Name:     account.raw("name"),
		Avatar:   runtime.userAvatar(*account),
		Admin:    account.raw("admin"),
		Password: nodeTruthyJSON(account.raw("password")),
		Created:  account.raw("created"),
	})
}

func (runtime *accountRuntime) serveUserLogout(w http.ResponseWriter, request *http.Request) {
	state := accountFromContext(request)
	if state.session == nil || runtime.options.CookieSecret == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	clearCookieSession(w, request, runtime.options)
	serveNoContent(w)
}

func (runtime *accountRuntime) serveUserChangeAvatar(w http.ResponseWriter, request *http.Request) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !nodeTruthyJSON(input["handle"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	state := accountFromContext(request)
	if state.user == nil {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	if !accountCanChangeTarget(state.user, input["handle"]) {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "Unauthorized"})
		return
	}
	var avatar string
	if json.Unmarshal(input["avatar"], &avatar) != nil {
		// The pinned handler calls startsWith directly. Missing and non-string
		// avatar values throw and are converted to its generic 500 response.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !strings.HasPrefix(avatar, "data:image/") && avatar != "" {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid data URL"})
		return
	}
	handle := nodeStringValue(input["handle"])
	if _, found, err := loadStoredAccount(runtime.options.DataRoot, handle); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	} else if !found {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}
	avatarJSON, err := marshalNodeJSON(avatar)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := startup.SetNodePersistRecord(runtime.options.DataRoot, avatarStoragePrefix+handle, avatarJSON); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveNoContent(w)
}

func (runtime *accountRuntime) serveUserChangeName(w http.ResponseWriter, request *http.Request) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !nodeTruthyJSON(input["name"]) || !nodeTruthyJSON(input["handle"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	state := accountFromContext(request)
	if state.user == nil {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	if !accountCanChangeTarget(state.user, input["handle"]) {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "Unauthorized"})
		return
	}
	handle := nodeStringValue(input["handle"])
	if _, found, err := loadStoredAccount(runtime.options.DataRoot, handle); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	} else if !found {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}
	if err := startup.UpdateNodePersistRecord(runtime.options.DataRoot, userStoragePrefix+handle, func(current json.RawMessage) (json.RawMessage, error) {
		return replaceJSONObjectMembers(current, []string{"name"}, map[string]json.RawMessage{"name": input["name"]})
	}); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveNoContent(w)
}

func (runtime *accountRuntime) serveUserChangePassword(w http.ResponseWriter, request *http.Request) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !nodeTruthyJSON(input["handle"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	state := accountFromContext(request)
	if state.user == nil {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	if !accountCanChangeTarget(state.user, input["handle"]) {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "Unauthorized"})
		return
	}
	handle := nodeStringValue(input["handle"])
	account, found, err := loadStoredAccount(runtime.options.DataRoot, handle)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !found {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}
	if !nodeTruthyJSON(account.raw("enabled")) {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "User is disabled"})
		return
	}
	isAdmin := nodeTruthyJSON(state.user.raw("admin"))
	if !isAdmin && nodeTruthyJSON(account.raw("password")) {
		var oldPassword string
		if json.Unmarshal(input["oldPassword"], &oldPassword) != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		computedHash, err := upstreamPasswordHash(oldPassword, account.string("salt"))
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if subtle.ConstantTimeCompare([]byte(computedHash), []byte(account.string("password"))) != 1 {
			respondJSON(w, http.StatusForbidden, map[string]string{"error": "Incorrect password"})
			return
		}
	}
	password := ""
	salt := ""
	if nodeTruthyJSON(input["newPassword"]) {
		if json.Unmarshal(input["newPassword"], &password) != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		saltBytes := make([]byte, 16)
		if _, err := rand.Read(saltBytes); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		salt = base64.StdEncoding.EncodeToString(saltBytes)
	}
	passwordHash := ""
	if password != "" {
		passwordHash, err = upstreamPasswordHash(password, salt)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	passwordJSON, _ := json.Marshal(passwordHash)
	saltJSON, _ := json.Marshal(salt)
	updatedAccount := storedAccount{}
	if err := startup.UpdateNodePersistRecord(runtime.options.DataRoot, userStoragePrefix+handle, func(current json.RawMessage) (json.RawMessage, error) {
		updatedValue, err := replaceJSONObjectMembers(current, []string{"password", "salt"}, map[string]json.RawMessage{
			"password": passwordJSON,
			"salt":     saltJSON,
		})
		if err != nil {
			return nil, err
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(updatedValue, &fields); err != nil || fields == nil {
			return nil, errors.New("updated user record is not a JSON object")
		}
		updatedAccount = storedAccount{fields: fields}
		return updatedValue, nil
	}); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if state.session != nil {
		if sessionHandle, hasHandle := state.session.stringValue("handle"); hasHandle && sessionHandle == account.string("handle") {
			state.session.set("version", updatedAccount.version())
			writeCookieSession(w, request, runtime.options, state.session)
		}
	}
	serveNoContent(w)
}

func (runtime *accountRuntime) serveUserAdminGet(w http.ResponseWriter, request *http.Request) {
	if _, ok := readAccountRequestBody(request); !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !requireAccountAdmin(w, request) {
		return
	}
	accounts, err := loadStoredAccounts(runtime.options.DataRoot)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	ordered := make([]storedAccount, 0, len(accounts))
	for _, account := range accounts {
		ordered = append(ordered, account)
	}
	sort.SliceStable(ordered, func(left, right int) bool {
		leftCreated := jsNumericValue(ordered[left].raw("created"))
		rightCreated := jsNumericValue(ordered[right].raw("created"))
		if leftCreated == rightCreated {
			return ordered[left].string("handle") < ordered[right].string("handle")
		}
		return leftCreated < rightCreated
	})
	viewModels := make([]adminUserViewModel, 0, len(ordered))
	for _, account := range ordered {
		viewModels = append(viewModels, adminUserViewModel{
			Handle:   account.raw("handle"),
			Name:     account.raw("name"),
			Avatar:   runtime.userAvatar(account),
			Admin:    account.raw("admin"),
			Enabled:  account.raw("enabled"),
			Created:  account.raw("created"),
			Password: nodeTruthyJSON(account.raw("password")),
		})
	}
	respondJSON(w, http.StatusOK, viewModels)
}

func (runtime *accountRuntime) serveUserAdminDisable(w http.ResponseWriter, request *http.Request) {
	runtime.serveUserAdminBooleanMutation(w, request, "enabled", false, true, "Cannot disable yourself")
}

func (runtime *accountRuntime) serveUserAdminEnable(w http.ResponseWriter, request *http.Request) {
	runtime.serveUserAdminBooleanMutation(w, request, "enabled", true, false, "")
}

func (runtime *accountRuntime) serveUserAdminPromote(w http.ResponseWriter, request *http.Request) {
	runtime.serveUserAdminBooleanMutation(w, request, "admin", true, false, "")
}

func (runtime *accountRuntime) serveUserAdminDemote(w http.ResponseWriter, request *http.Request) {
	runtime.serveUserAdminBooleanMutation(w, request, "admin", false, true, "Cannot demote yourself")
}

func (runtime *accountRuntime) serveUserAdminBooleanMutation(w http.ResponseWriter, request *http.Request, field string, value, preventSelf bool, selfError string) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !requireAccountAdmin(w, request) {
		return
	}
	if !nodeTruthyJSON(input["handle"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	state := accountFromContext(request)
	if preventSelf && requestHandleMatches(input["handle"], state.user.string("handle")) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": selfError})
		return
	}
	handle := nodeStringValue(input["handle"])
	if _, found, err := loadStoredAccount(runtime.options.DataRoot, handle); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	} else if !found {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}
	encoded, _ := json.Marshal(value)
	if err := startup.UpdateNodePersistRecord(runtime.options.DataRoot, userStoragePrefix+handle, func(current json.RawMessage) (json.RawMessage, error) {
		return replaceJSONObjectMembers(current, []string{field}, map[string]json.RawMessage{field: encoded})
	}); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveNoContent(w)
}

func (runtime *accountRuntime) serveUserAdminDelete(w http.ResponseWriter, request *http.Request) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if !requireAccountAdmin(w, request) {
		return
	}
	if !nodeTruthyJSON(input["handle"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	state := accountFromContext(request)
	if requestHandleMatches(input["handle"], state.user.string("handle")) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Cannot delete yourself"})
		return
	}
	if requestHandleMatches(input["handle"], "default-user") {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Sorry, but the default user cannot be deleted. It is required as a fallback."})
		return
	}
	if runtime.options.DataRoot == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	handle := nodeStringValue(input["handle"])
	purge := nodeTruthyJSON(input["purge"])
	var userRoot string
	if purge {
		directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, handle)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		dataRoot, err := filepath.Abs(runtime.options.DataRoot)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		userRoot = filepath.Clean(directories["root"])
		if userRoot == filepath.Clean(dataRoot) {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	if err := startup.RemoveNodePersistRecord(runtime.options.DataRoot, userStoragePrefix+handle); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if purge {
		if err := os.RemoveAll(userRoot); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	serveNoContent(w)
}

func requireAccountAdmin(w http.ResponseWriter, request *http.Request) bool {
	state := accountFromContext(request)
	if state.user == nil || !nodeTruthyJSON(state.user.raw("admin")) {
		serveStatusText(w, http.StatusForbidden)
		return false
	}
	return true
}

func requestHandleMatches(raw json.RawMessage, handle string) bool {
	var requestHandle string
	return json.Unmarshal(raw, &requestHandle) == nil && requestHandle == handle
}

func accountCanChangeTarget(current *storedAccount, target json.RawMessage) bool {
	if !nodeTruthyJSON(current.raw("admin")) {
		var targetHandle string
		if json.Unmarshal(target, &targetHandle) != nil || targetHandle != current.string("handle") {
			return false
		}
	}
	return true
}

func nodeStringValue(raw json.RawMessage) string {
	var value any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return "undefined"
	}
	switch typed := value.(type) {
	case nil:
		return "null"
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		if typed == 0 {
			return "0"
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case []any:
		parts := make([]string, len(typed))
		for index, item := range typed {
			if item == nil {
				continue
			}
			encoded, err := json.Marshal(item)
			if err != nil {
				parts[index] = "[object Object]"
				continue
			}
			if json.Unmarshal(encoded, &parts[index]) != nil {
				parts[index] = string(encoded)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

func (runtime *accountRuntime) recoveryCode(handle string, now time.Time) string {
	runtime.recoveryMu.Lock()
	defer runtime.recoveryMu.Unlock()
	entry, found := runtime.recoveryCodes[handle]
	if !found {
		return ""
	}
	if !entry.expires.After(now) {
		delete(runtime.recoveryCodes, handle)
		return ""
	}
	return entry.code
}

func generateRecoveryCode() (string, error) {
	var code strings.Builder
	code.Grow(6)
	for range 6 {
		digit, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		code.WriteByte(byte('0' + digit.Int64()))
	}
	return code.String(), nil
}

func readAccountRequestBody(request *http.Request) (map[string]json.RawMessage, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, 500<<20))
	if err != nil {
		return nil, false
	}
	input := make(map[string]json.RawMessage)
	if len(bytes.TrimSpace(body)) > 0 && json.Unmarshal(body, &input) != nil {
		return nil, false
	}
	if input == nil {
		input = make(map[string]json.RawMessage)
	}
	return input, true
}

func serveAccountRateLimit(w http.ResponseWriter, wait time.Duration, message string) {
	seconds := int64((wait + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	respondJSON(w, http.StatusTooManyRequests, map[string]string{"error": message})
}

func serveNoContent(w http.ResponseWriter) {
	w.Header().Set("ETag", expressWeakETag([]byte(http.StatusText(http.StatusNoContent))))
	w.Header().Set("Vary", "Origin")
	w.WriteHeader(http.StatusNoContent)
}

func replaceJSONObjectMembers(value []byte, order []string, replacements map[string]json.RawMessage) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(value))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errors.New("user record is not a JSON object")
	}
	type member struct {
		key   string
		value json.RawMessage
	}
	members := make([]member, 0, len(replacements)+4)
	seen := make(map[string]bool, len(replacements))
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("user record contains a non-string object key")
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, err
		}
		if replacement, exists := replacements[key]; exists {
			raw = replacement
			seen[key] = true
		}
		members = append(members, member{key: key, value: compactJSON(raw)})
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	for _, key := range order {
		if !seen[key] {
			members = append(members, member{key: key, value: compactJSON(replacements[key])})
		}
	}
	var result bytes.Buffer
	result.WriteByte('{')
	for index, item := range members {
		if index > 0 {
			result.WriteByte(',')
		}
		encodedKey, err := marshalNodeJSON(item.key)
		if err != nil {
			return nil, err
		}
		result.Write(encodedKey)
		result.WriteByte(':')
		result.Write(item.value)
	}
	result.WriteByte('}')
	return result.Bytes(), nil
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
