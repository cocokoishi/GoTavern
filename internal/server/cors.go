package server

import (
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
)

type pinnedCORSSettings struct {
	enabled        bool
	origin         any
	methods        any
	allowedHeaders any
	exposedHeaders any
	credentials    bool
	maxAge         any
}

func pinnedCORSSettingsFromOptions(options HTTPHandlerOptions) pinnedCORSSettings {
	settings := pinnedCORSSettings{
		enabled:        true,
		origin:         []any{"null"},
		methods:        []any{"OPTIONS"},
		allowedHeaders: []any{},
		exposedHeaders: []any{},
	}
	if options.CorsEnabled != nil {
		settings.enabled = *options.CorsEnabled
	}
	if options.CorsCredentials != nil {
		settings.credentials = *options.CorsCredentials
	}
	if options.CorsSettingsConfigured || options.CorsOrigin != nil {
		settings.origin = options.CorsOrigin
	}
	if options.CorsSettingsConfigured || options.CorsMethods != nil {
		settings.methods = options.CorsMethods
	}
	if options.CorsSettingsConfigured || options.CorsAllowedHeaders != nil {
		settings.allowedHeaders = options.CorsAllowedHeaders
	}
	if options.CorsSettingsConfigured || options.CorsExposedHeaders != nil {
		settings.exposedHeaders = options.CorsExposedHeaders
	}
	settings.maxAge = options.CorsMaxAge
	return settings
}

func setPinnedCORSBaseVary(header http.Header, settings pinnedCORSSettings) {
	vary := "Accept-Encoding"
	if settings.enabled && corsTruthy(settings.origin) && corsOriginVaries(settings.origin) {
		vary = "Origin, Accept-Encoding"
	}
	header.Set("Vary", vary)
}

func servePinnedCORS(writer http.ResponseWriter, request *http.Request, settings pinnedCORSSettings) bool {
	if !settings.enabled || !corsTruthy(settings.origin) {
		return false
	}
	header := writer.Header()
	requestOrigin, hasOrigin := request.Header[http.CanonicalHeaderKey("Origin")]
	origin := ""
	if len(requestOrigin) > 0 {
		origin = requestOrigin[0]
	}
	if value, allowed := corsAllowOriginHeader(settings.origin, origin, hasOrigin); allowed && value != "" {
		header.Set("Access-Control-Allow-Origin", value)
	}
	if settings.credentials {
		header.Set("Access-Control-Allow-Credentials", "true")
	}
	if value, exists := corsConfiguredHeaderList(settings.exposedHeaders); exists && value != "" {
		header.Set("Access-Control-Expose-Headers", value)
	}
	if request.Method != http.MethodOptions {
		return false
	}
	if value, exists := corsHeaderValue(settings.methods); exists && value != "" {
		header.Set("Access-Control-Allow-Methods", value)
	}
	if value, configured := corsConfiguredHeaderList(settings.allowedHeaders); configured {
		if value != "" {
			header.Set("Access-Control-Allow-Headers", value)
		}
	} else if values := request.Header[http.CanonicalHeaderKey("Access-Control-Request-Headers")]; len(values) > 0 && values[0] != "" {
		header.Set("Access-Control-Allow-Headers", values[0])
	}
	if value, exists := corsIntegerString(settings.maxAge); exists {
		header.Set("Access-Control-Max-Age", value)
	}
	vary := make([]string, 0, 2)
	if corsOriginVaries(settings.origin) {
		vary = append(vary, "Origin")
	}
	if _, configured := corsConfiguredHeaderList(settings.allowedHeaders); !configured {
		vary = append(vary, "Access-Control-Request-Headers")
	}
	if len(vary) == 0 {
		header.Del("Vary")
	} else {
		header.Set("Vary", strings.Join(vary, ", "))
	}
	header.Set("Content-Length", "0")
	writer.WriteHeader(http.StatusNoContent)
	return true
}

// These Go handlers dispatch methods manually; the pinned Express routes retain their POST method metadata.
func pinnedExpressMethodlessOptionsMethods() map[string][]string {
	return map[string][]string{
		"/api/avatars/upload":                    {http.MethodPost},
	"/api/backgrounds/upload":                    {http.MethodPost},
		"/api/backgrounds/folders":                   {http.MethodPost},
		"/api/image-metadata":                        {http.MethodPost},
		"/api/image-metadata/{$}":                    {http.MethodPost},
		"/api/image-metadata/all":                    {http.MethodPost},
		"/api/image-metadata/cleanup":                {http.MethodPost},
		"/api/image-metadata/folders/assign":         {http.MethodPost},
		"/api/image-metadata/folders/create":         {http.MethodPost},
		"/api/image-metadata/folders/delete":         {http.MethodPost},
		"/api/image-metadata/folders/get":            {http.MethodPost},
		"/api/image-metadata/folders/set-thumbnails": {http.MethodPost},
		"/api/image-metadata/folders/unassign":       {http.MethodPost},
		"/api/image-metadata/folders/update":         {http.MethodPost},
	}
}

func servePinnedExpressAutomaticOptions(writer http.ResponseWriter, request *http.Request, mux *http.ServeMux, methodlessRoutes map[string][]string) bool {
	if request.Method != http.MethodOptions || mux == nil ||
		(request.URL.Path != "/api" && !strings.HasPrefix(request.URL.Path, "/api/")) {
		return false
	}
	if _, pattern := mux.Handler(request); pattern != "" && pattern != "/" {
		_, _, methodQualified := strings.Cut(pattern, " ")
		if methodQualified {
			return false
		}
		methods, exists := methodlessRoutes[pattern]
		if !exists {
			return false
		}
		return writePinnedExpressAutomaticOptions(writer, methods)
	}

	methods := make([]string, 0, 4)
	hasGet := false
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodConnect, http.MethodTrace} {
		candidate := request.Clone(request.Context())
		candidate.Method = method
		_, pattern := mux.Handler(candidate)
		routeMethod, _, methodQualified := strings.Cut(pattern, " ")
		if !methodQualified || routeMethod != method {
			continue
		}
		methods = append(methods, method)
		if method == http.MethodGet {
			hasGet = true
		}
	}
	if hasGet {
		methods = append(methods, http.MethodHead)
	} else {
		candidate := request.Clone(request.Context())
		candidate.Method = http.MethodHead
		_, pattern := mux.Handler(candidate)
		routeMethod, _, methodQualified := strings.Cut(pattern, " ")
		if methodQualified && routeMethod == http.MethodHead {
			methods = append(methods, http.MethodHead)
		}
	}
	return writePinnedExpressAutomaticOptions(writer, methods)
}

func writePinnedExpressAutomaticOptions(writer http.ResponseWriter, methods []string) bool {
	if len(methods) == 0 {
		return false
	}

	body := strings.Join(methods, ",")
	header := writer.Header()
	header.Set("Allow", body)
	header.Set("Content-Type", "text/html; charset=utf-8")
	header.Set("Content-Length", strconv.Itoa(len(body)))
	writer.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(writer, body)
	return true
}

func corsAllowOriginHeader(configured any, requestOrigin string, hasOrigin bool) (string, bool) {
	if origin, ok := configured.(string); ok {
		if origin == "*" {
			return "*", true
		}
		return origin, true
	}
	if corsOriginAllows(configured, requestOrigin, hasOrigin) && hasOrigin {
		return requestOrigin, true
	}
	return "", false
}

func corsOriginAllows(configured any, requestOrigin string, hasOrigin bool) bool {
	switch allowed := configured.(type) {
	case []any:
		for _, candidate := range allowed {
			if value, ok := candidate.(string); ok {
				if hasOrigin && value == requestOrigin {
					return true
				}
				continue
			}
			if corsTruthy(candidate) {
				return true
			}
		}
		return false
	case []string:
		for _, candidate := range allowed {
			if hasOrigin && candidate == requestOrigin {
				return true
			}
		}
		return false
	default:
		return corsTruthy(configured)
	}
}

func corsOriginVaries(origin any) bool {
	value, isString := origin.(string)
	return !isString || value != "*"
}

func corsConfiguredHeaderList(value any) (string, bool) {
	values, isArray := corsArray(value)
	if !isArray || len(values) == 0 {
		return "", false
	}
	parts := make([]string, len(values))
	for index, item := range values {
		parts[index] = corsJavaScriptString(item)
	}
	joined := strings.Join(parts, ",")
	return joined, true
}

func corsArray(value any) ([]any, bool) {
	switch values := value.(type) {
	case []any:
		return values, true
	case []string:
		result := make([]any, len(values))
		for index, item := range values {
			result[index] = item
		}
		return result, true
	default:
		return nil, false
	}
}

func corsHeaderValue(value any) (string, bool) {
	if values, isArray := corsArray(value); isArray {
		parts := make([]string, len(values))
		for index, item := range values {
			parts[index] = corsJavaScriptString(item)
		}
		return strings.Join(parts, ","), true
	}
	if value == nil {
		return "", false
	}
	return corsJavaScriptString(value), true
}

func corsJavaScriptString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 32)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case []any:
		parts := make([]string, len(typed))
		for index, item := range typed {
			parts[index] = corsJavaScriptString(item)
		}
		return strings.Join(parts, ",")
	case []string:
		return strings.Join(typed, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return ""
	}
}

func corsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	case float32:
		return typed != 0 && !float32IsNaN(typed)
	case int:
		return typed != 0
	case int64:
		return typed != 0
	default:
		return true
	}
}

func float32IsNaN(value float32) bool {
	return math.IsNaN(float64(value))
}

func corsIntegerString(value any) (string, bool) {
	var number float64
	switch typed := value.(type) {
	case int:
		number = float64(typed)
	case int64:
		number = float64(typed)
	case float64:
		number = typed
	case float32:
		number = float64(typed)
	default:
		return "", false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number {
		return "", false
	}
	return strconv.FormatFloat(number, 'f', 0, 64), true
}
