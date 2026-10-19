package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const basicAuthWindow = 60 * time.Second

type basicAuthRuntime struct {
	mu      sync.Mutex
	points  float64
	entries map[string]basicAuthEntry
}

type basicAuthEntry struct {
	consumed float64
	expires  time.Time
}

func newBasicAuthRuntime(options HTTPHandlerOptions) *basicAuthRuntime {
	points := 5.0
	if options.BasicAuthRateLimit != nil {
		points = *options.BasicAuthRateLimit
	}
	if points <= 0 || math.IsNaN(points) {
		points = 9007199254740991
	}
	return &basicAuthRuntime{points: points, entries: make(map[string]basicAuthEntry)}
}

func (runtime *basicAuthRuntime) authenticate(writer http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) bool {
	authorization := request.Header.Get("Authorization")
	if authorization == "" {
		serveBasicAuthUnauthorized(writer, request, options)
		return false
	}

	parts := strings.Split(authorization, " ")
	if len(parts) < 2 || parts[0] != "Basic" || parts[1] == "" {
		serveBasicAuthUnauthorized(writer, request, options)
		return false
	}

	key := basicAuthRateLimitKey(request, options)
	now := time.Now()
	runtime.mu.Lock()
	entry, found := runtime.entries[key]
	if found && !now.Before(entry.expires) {
		delete(runtime.entries, key)
		found = false
	}
	if found && entry.consumed > runtime.points {
		retryAfter := time.Until(entry.expires)
		runtime.mu.Unlock()
		serveBasicAuthRateLimited(writer, request, retryAfter)
		return false
	}
	runtime.mu.Unlock()

	username, password := decodeBasicCredentials(parts[1])
	matched, err := basicAuthCredentialMatches(username, password, options)
	if err != nil {
		serveStatusText(writer, http.StatusInternalServerError)
		return false
	}
	if matched {
		runtime.mu.Lock()
		delete(runtime.entries, key)
		runtime.mu.Unlock()
		return true
	}

	now = time.Now()
	runtime.mu.Lock()
	entry, found = runtime.entries[key]
	if found && !now.Before(entry.expires) {
		delete(runtime.entries, key)
		found = false
	}
	if !found {
		entry = basicAuthEntry{expires: now.Add(basicAuthWindow)}
	}
	entry.consumed++
	runtime.entries[key] = entry
	overLimit := entry.consumed > runtime.points
	retryAfter := time.Until(entry.expires)
	runtime.mu.Unlock()
	if overLimit {
		serveBasicAuthRateLimited(writer, request, retryAfter)
		return false
	}
	serveBasicAuthUnauthorized(writer, request, options)
	return false
}

func basicAuthRateLimitKey(request *http.Request, options HTTPHandlerOptions) string {
	clientIP := requestClientIP(request)
	if !options.PreferRealIPHeader {
		return clientIP
	}
	if forwardedIP := realOrForwardedIP(request, options); forwardedIP != "" {
		return clientIP + " (forwarded: " + forwardedIP + ")"
	}
	return clientIP
}

func basicAuthCredentialMatches(username, password string, options HTTPHandlerOptions) (bool, error) {
	if options.PerUserBasicAuth && options.AccountsEnabled {
		account, err := findPerUserBasicAuthAccount(username, password, options.DataRoot)
		return account != nil, err
	}
	configuredUsername, usernameIsString := options.BasicAuthUsername.(string)
	configuredPassword, passwordIsString := options.BasicAuthPassword.(string)
	return usernameIsString && passwordIsString && username == configuredUsername && password == configuredPassword, nil
}

func findPerUserBasicAuthAccount(username, password, dataRoot string) (*storedAccount, error) {
	accounts, err := loadStoredAccounts(dataRoot)
	if err != nil {
		return nil, err
	}
	account, found := accounts[username]
	if !found {
		return nil, nil
	}
	matched, err := storedAccountMatchesBasicAuth(account, password)
	if err != nil || !matched {
		return nil, err
	}
	return &account, nil
}

func storedAccountMatchesBasicAuth(account storedAccount, password string) (bool, error) {
	if !nodeTruthyJSON(account.raw("enabled")) || !nodeTruthyJSON(account.raw("password")) {
		return false, nil
	}
	var salt string
	if len(account.raw("salt")) == 0 || json.Unmarshal(account.raw("salt"), &salt) != nil {
		return false, errors.New("per-user Basic Auth account has a non-string salt")
	}
	computedHash, err := upstreamPasswordHash(password, salt)
	if err != nil {
		return false, err
	}
	var storedHash string
	if json.Unmarshal(account.raw("password"), &storedHash) != nil {
		return false, nil
	}
	return computedHash == storedHash, nil
}

func decodeBasicCredentials(value string) (string, string) {
	decoded := decodeNodeBase64(value)
	username, password, found := strings.Cut(string(decoded), ":")
	if !found {
		return username, ""
	}
	return username, password
}

func decodeNodeBase64(value string) []byte {
	value = strings.NewReplacer("-", "+", "_", "/").Replace(value)
	var filtered strings.Builder
	for _, character := range value {
		if character == '=' {
			break
		}
		if (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '+' || character == '/' {
			filtered.WriteRune(character)
		}
	}
	encoded := filtered.String()
	if len(encoded)%4 == 1 {
		return nil
	}
	decoded, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return nil
	}
	return decoded
}

func serveBasicAuthUnauthorized(writer http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	var body []byte
	if options.DataRoot != "" {
		body, _ = os.ReadFile(filepath.Join(options.DataRoot, "_errors", "unauthorized.html"))
	}
	writer.Header().Set("WWW-Authenticate", `Basic realm="SillyTavern", charset="UTF-8"`)
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
	writer.Header().Set("ETag", expressWeakETag(body))
	writer.WriteHeader(http.StatusUnauthorized)
	if request.Method != http.MethodHead {
		_, _ = writer.Write(body)
	}
}

func serveBasicAuthRateLimited(writer http.ResponseWriter, request *http.Request, retryAfter time.Duration) {
	seconds := int64(math.Ceil(retryAfter.Seconds()))
	body := http.StatusText(http.StatusTooManyRequests)
	bodyBytes := []byte(body)
	writer.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.Header().Set("Content-Length", strconv.Itoa(len(bodyBytes)))
	writer.Header().Set("ETag", expressWeakETag(bodyBytes))
	writer.WriteHeader(http.StatusTooManyRequests)
	if request.Method != http.MethodHead {
		_, _ = writer.Write(bodyBytes)
	}
}
