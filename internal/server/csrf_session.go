package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const invalidCSRFBrowserPage = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>ForbiddenError: Invalid CSRF token. Please refresh the page and try again.</pre>\n</body>\n</html>\n"

type csrfSessionContextKey struct{}

type cookieSession struct {
	fields        map[string]json.RawMessage
	order         []string
	originalValue string
}

func withSession(ctx context.Context, session *cookieSession) context.Context {
	return context.WithValue(ctx, csrfSessionContextKey{}, session)
}

func sessionFromContext(ctx context.Context) *cookieSession {
	session, _ := ctx.Value(csrfSessionContextKey{}).(*cookieSession)
	return session
}

func newCookieSession() *cookieSession {
	return &cookieSession{fields: make(map[string]json.RawMessage)}
}

func (session *cookieSession) stringValue(name string) (string, bool) {
	if session == nil {
		return "", false
	}
	var value string
	raw, found := session.fields[name]
	if !found || json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func (session *cookieSession) set(name string, value any) bool {
	encoded, err := json.Marshal(value)
	if err != nil {
		return false
	}
	if old, found := session.fields[name]; found && bytes.Equal(compactJSON(old), encoded) {
		return false
	}
	if _, found := session.fields[name]; !found {
		session.order = append(session.order, name)
	}
	session.fields[name] = encoded
	return true
}

func (session *cookieSession) serialized() []byte {
	var body bytes.Buffer
	body.WriteByte('{')
	for _, name := range session.order {
		value, found := session.fields[name]
		if !found {
			continue
		}
		if body.Len() > 1 {
			body.WriteByte(',')
		}
		encodedName, _ := json.Marshal(name)
		body.Write(encodedName)
		body.WriteByte(':')
		body.Write(compactJSON(value))
	}
	body.WriteByte('}')
	return body.Bytes()
}

func compactJSON(value []byte) []byte {
	if len(value) == 0 {
		return nil
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, value); err != nil {
		return value
	}
	return compact.Bytes()
}

func loadCookieSession(request *http.Request, options HTTPHandlerOptions) *cookieSession {
	session := newCookieSession()
	if options.CookieSecret == "" {
		return session
	}

	name := sessionCookieName()
	cookie, err := request.Cookie(name)
	if err != nil || cookie.Value == "" {
		return session
	}
	signature, err := request.Cookie(name + ".sig")
	if err != nil || !keygripValid(options.CookieSecret, name+"="+cookie.Value, signature.Value) {
		return session
	}

	encoded, err := base64.StdEncoding.DecodeString(cookie.Value)
	if err != nil {
		return session
	}
	fields, order, ok := parseOrderedSession(encoded)
	if !ok {
		return session
	}
	session.fields = fields
	session.order = order
	session.originalValue = cookie.Value
	return session
}

func parseOrderedSession(encoded []byte) (map[string]json.RawMessage, []string, bool) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, nil, false
	}
	fields := make(map[string]json.RawMessage)
	var order []string
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, nil, false
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, nil, false
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, nil, false
		}
		if _, exists := fields[key]; !exists {
			order = append(order, key)
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, nil, false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, nil, false
	}
	return fields, order, true
}

func sessionCookieName() string {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "localhost"
	}
	digest := sha256.Sum256([]byte(hostname))
	return fmt.Sprintf("session-%x", digest[:4])
}

func keygripValid(secret, value, signature string) bool {
	return hmac.Equal([]byte(keygripSign(secret, value)), []byte(signature))
}

func keygripSign(secret, value string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(value))
	return strings.NewReplacer("/", "_", "+", "-", "=", "").Replace(base64.StdEncoding.EncodeToString(mac.Sum(nil)))
}

func requiresCSRFSynchronization(request *http.Request, options HTTPHandlerOptions) bool {
	switch request.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	}
	return !(options.EnableCorsProxy && strings.HasPrefix(request.URL.Path, "/proxy/"))
}

func serveCSRFToken(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	session := sessionFromContext(request.Context())
	if session == nil || options.CookieSecret == "" {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	token, found := session.stringValue("csrfToken")
	if !found {
		var randomToken [32]byte
		if _, err := rand.Read(randomToken[:]); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		token = hex.EncodeToString(randomToken[:])
		session.set("csrfToken", token)
	}
	body, err := json.Marshal(struct {
		Token string `json:"token"`
	}{Token: token})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if session.shouldWrite() {
		writeCookieSession(w, request, options, session)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.Header().Set("Vary", "Origin, Accept-Encoding")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func csrfTokenFromHeader(request *http.Request) (string, bool) {
	values, found := request.Header[http.CanonicalHeaderKey("X-CSRF-Token")]
	if !found {
		return "", false
	}
	return strings.Join(values, ","), len(values) > 0
}

func serveDisabledCSRFToken(w http.ResponseWriter, request *http.Request) {
	body := []byte(`{"token":"disabled"}`)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.Header().Set("Vary", "Origin, Accept-Encoding")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (session *cookieSession) shouldWrite() bool {
	if session == nil || len(session.fields) == 0 {
		return false
	}
	serialized := session.serialized()
	if session.originalValue == "" {
		return true
	}
	return base64.StdEncoding.EncodeToString(serialized) != session.originalValue
}

func writeCookieSession(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions, session *cookieSession) {
	name := sessionCookieName()
	value := base64.StdEncoding.EncodeToString(session.serialized())
	cookieData := name + "=" + value
	attributes := sessionCookieAttributes(request, options)
	w.Header().Add("Set-Cookie", cookieData+attributes)
	w.Header().Add("Set-Cookie", name+".sig="+keygripSign(options.CookieSecret, cookieData)+attributes)
}

func sessionCookieAttributes(request *http.Request, options HTTPHandlerOptions) string {
	attributes := "; path=/"
	if timeout := sessionTimeout(options); timeout != nil {
		expires := time.Now().Add(*timeout).UTC().Format("Mon, 02 Jan 2006 15:04:05 GMT")
		attributes += "; expires=" + expires
	}
	attributes += "; samesite=lax; httponly"
	if request.TLS != nil {
		attributes += "; secure"
	}
	return attributes
}

func sessionTimeout(options HTTPHandlerOptions) *time.Duration {
	seconds := -1.0
	if options.SessionTimeoutSeconds != nil {
		seconds = *options.SessionTimeoutSeconds
	}
	switch {
	case seconds > 0:
		duration := time.Duration(seconds * float64(time.Second))
		return &duration
	case seconds < 0:
		duration := 400 * 24 * time.Hour
		return &duration
	default:
		return nil
	}
}

func serveInvalidCSRFToken(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(invalidCSRFBrowserPage)))
	w.Header().Set("Vary", "Origin, Accept-Encoding")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(invalidCSRFBrowserPage))
}

func servePing(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	if options.AccountsEnabled {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if request.URL.Query().Get("extend") != "" {
		if session := sessionFromContext(request.Context()); session != nil && options.CookieSecret != "" {
			session.set("touch", time.Now().UnixMilli())
			if session.shouldWrite() {
				writeCookieSession(w, request, options, session)
			}
		}
	}
	w.Header().Set("ETag", expressWeakETag([]byte("No Content")))
	w.Header().Set("Vary", "Origin")
	w.WriteHeader(http.StatusNoContent)
}
