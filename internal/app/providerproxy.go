package app

import (
	"fmt"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/outbound"
)

// configureProviderProxy hands pinned's requestProxy setting to the provider transport.
//
// WHY THIS EXISTS AT ALL: pinned parses requestProxy.enabled / requestProxyUrl / requestProxyBypass into its
// command-line options, a stock SillyTavern config carries them, and a user behind a proxy sets them as the
// documented way to reach a provider. Before this call, GoTavern read none of them -- eleven occurrences in
// internal/** and cmd/**, every one of them in the parse/default/metadata layer and zero readers -- so that
// user was unreachable however correct their config was (measured as transport.proxy-connect-ignored).
//
// The three values arrive as `any` because the option layer keeps them in their JSON shapes. The coercions
// below are deliberately strict about the ONE case that matters: an enabled proxy with no usable URL must be
// an error at boot rather than a silent direct dial, because the difference is "your provider is unreachable"
// versus "requestProxy is enabled but has no URL".
func configureProviderProxy(options commandline.ServerOptions) error {
	enabled, enabledErr := proxyBool(options.RequestProxyEnabled, "requestProxy.enabled")
	if enabledErr != nil {
		return enabledErr
	}
	rawURL, urlErr := proxyString(options.RequestProxyURL, "requestProxy.url")
	if urlErr != nil {
		return urlErr
	}
	bypass, bypassErr := proxyStringSlice(options.RequestProxyBypass, "requestProxy.bypass")
	if bypassErr != nil {
		return bypassErr
	}
	if err := outbound.ConfigureRequestProxy(enabled, rawURL, bypass); err != nil {
		return fmt.Errorf("apply the requestProxy configuration: %w", err)
	}
	return nil
}

func proxyBool(value any, field string) (bool, error) {
	switch typed := value.(type) {
	case nil:
		return false, nil
	case bool:
		return typed, nil
	default:
		return false, fmt.Errorf("%s must be true or false, got %T (%v); an unparseable value is refused rather than guessed, because guessing ON would route every provider call through a proxy nobody chose", field, value, value)
	}
}

func proxyString(value any, field string) (string, error) {
	switch typed := value.(type) {
	case nil:
		return "", nil
	case string:
		return typed, nil
	default:
		return "", fmt.Errorf("%s must be a string, got %T (%v)", field, value, value)
	}
}

func proxyStringSlice(value any, field string) ([]string, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case []any:
		result := make([]string, 0, len(typed))
		for _, entry := range typed {
			text, ok := entry.(string)
			if !ok {
				return nil, fmt.Errorf("%s entries must be strings, got %T (%v)", field, entry, entry)
			}
			result = append(result, text)
		}
		return result, nil
	case []string:
		return typed, nil
	default:
		return nil, fmt.Errorf("%s must be a list, got %T (%v)", field, value, value)
	}
}
