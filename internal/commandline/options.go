package commandline

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// ServerOptions contains the data returned by the pinned CommandLineParser.
// Values that are not converted by upstream are kept as generic YAML/JSON
// values, including intentionally unusual config values.
type ServerOptions struct {
	Port                        any `json:"port"`
	Listen                      any `json:"listen"`
	ListenAddressIPv6           any `json:"listenAddressIPv6"`
	ListenAddressIPv4           any `json:"listenAddressIPv4"`
	EnableIPv4                  any `json:"enableIPv4"`
	EnableIPv6                  any `json:"enableIPv6"`
	DNSPreferIPv6               any `json:"dnsPreferIPv6"`
	HeartbeatInterval           any `json:"heartbeatInterval"`
	BrowserLaunchEnabled        any `json:"browserLaunchEnabled"`
	BrowserLaunchHostname       any `json:"browserLaunchHostname"`
	BrowserLaunchPort           any `json:"browserLaunchPort"`
	BrowserLaunchAvoidLocalhost any `json:"browserLaunchAvoidLocalhost"`
	EnableCorsProxy             any `json:"enableCorsProxy"`
	DisableCsrf                 any `json:"disableCsrf"`
	SSL                         any `json:"ssl"`
	CertPath                    any `json:"certPath"`
	KeyPath                     any `json:"keyPath"`
	KeyPassphrase               any `json:"keyPassphrase"`
	WhitelistMode               any `json:"whitelistMode"`
	BasicAuthMode               any `json:"basicAuthMode"`
	EnableKeepAlive             any `json:"enableKeepAlive"`
	RequestProxyEnabled         any `json:"requestProxyEnabled"`
	RequestProxyURL             any `json:"requestProxyUrl"`
	RequestProxyBypass          any `json:"requestProxyBypass"`
}

// OptionWarnings records protocol values that the pinned parser replaces
// with the platform defaults after printing a warning.
type OptionWarnings struct {
	InvalidIPv4Protocol bool `json:"invalidIPv4Protocol"`
	InvalidIPv6Protocol bool `json:"invalidIPv6Protocol"`
}

// StartupSettings are config-derived values consumed by server-main's ordered
// pre-listener startup chain. Generic values retain the upstream getter's
// output instead of silently coercing malformed or unknown YAML.
type StartupSettings struct {
	LegacyCookieSecret         any  `json:"legacyCookieSecret"`
	SessionTimeout             any  `json:"sessionTimeout"`
	EnableUserAccounts         any  `json:"enableUserAccounts"`
	EnableDiscreetLogin        any  `json:"enableDiscreetLogin"`
	SecurityOverride           any  `json:"securityOverride"`
	PerUserBasicAuth           any  `json:"perUserBasicAuth"`
	PreferRealIPHeader         any  `json:"preferRealIPHeader"`
	BasicAuthMaxAttempts       any  `json:"basicAuthMaxAttempts"`
	AccountsLoginMaxAttempts   any  `json:"accountsLoginMaxAttempts"`
	AccountsRecoverMaxAttempts any  `json:"accountsRecoverMaxAttempts"`
	AccountsResetMaxAttempts   any  `json:"accountsResetMaxAttempts"`
	AllowFullDataBackup        any  `json:"allowFullDataBackup"`
	AllowKeysExposure          any  `json:"allowKeysExposure"`
	ExtensionsEnabled          any  `json:"extensionsEnabled"`
	ExtensionsAutoUpdate       any  `json:"extensionsAutoUpdate"`
	RequestCompressionEnabled  any  `json:"requestCompressionEnabled"`
	RequestCompressionMin      any  `json:"requestCompressionMin"`
	RequestCompressionMax      any  `json:"requestCompressionMax"`
	RequestCompressionTimeout  any  `json:"requestCompressionTimeout"`
	CorsEnabled                any  `json:"corsEnabled"`
	CorsOrigin                 any  `json:"corsOrigin"`
	CorsMethods                any  `json:"corsMethods"`
	CorsAllowedHeaders         any  `json:"corsAllowedHeaders"`
	CorsExposedHeaders         any  `json:"corsExposedHeaders"`
	CorsCredentials            any  `json:"corsCredentials"`
	CorsMaxAge                 any  `json:"corsMaxAge"`
	ThumbnailDimensionsBG      any  `json:"thumbnailDimensionsBG"`
	ThumbnailDimensionsAvatar  any  `json:"thumbnailDimensionsAvatar"`
	ThumbnailDimensionsPersona any  `json:"thumbnailDimensionsPersona"`
	ThumbnailDimensionsSet     bool `json:"-"`
	ThumbnailsEnabled          any  `json:"-"`
	ThumbnailsFormat           any  `json:"-"`
	ThumbnailsQuality          any  `json:"-"`
	ForwardedXRealIP           any  `json:"forwardedXRealIP"`
	ForwardedCFConnectingIP    any  `json:"forwardedCFConnectingIP"`
	ForwardedXForwardedFor     any  `json:"forwardedXForwardedFor"`
	EnableForwardedWhitelist   any  `json:"enableForwardedWhitelist"`
	Whitelist                  any  `json:"whitelist"`
	WhitelistDockerHosts       any  `json:"whitelistDockerHosts"`
	HostWhitelistEnabled       any  `json:"hostWhitelistEnabled"`
	HostWhitelistScan          any  `json:"hostWhitelistScan"`
	HostWhitelistHosts         any  `json:"hostWhitelistHosts"`
	BasicAuthUsername          any  `json:"basicAuthUsername"`
	BasicAuthPassword          any  `json:"basicAuthPassword"`
	SkipContentCheck           any  `json:"skipContentCheck"`
	UseDiskCache               any  `json:"useDiskCache"`
	SettingsBackupRetention    any  `json:"settingsBackupRetention"`
}

// CommandLineResult combines the path side effects and option values returned
// while server.js prepares its runtime configuration.
type CommandLineResult struct {
	Paths           ResolvedPaths   `json:"-"`
	Options         ServerOptions   `json:"options"`
	StartupSettings StartupSettings `json:"startupSettings"`
	Warnings        OptionWarnings  `json:"warnings"`
	// TokenizersDownloadAllowed carries enableDownloadableTokenizers, which the pinned server
	// reads directly from the config rather than through its startup settings map. It is
	// excluded from the serialized result so the command-line differential still compares the
	// same map Node produces.
	TokenizersDownloadAllowed *bool `json:"-"`
	// ImportDomainsWhitelist carries whitelistImportDomains, which the pinned
	// src/endpoints/content-manager.js reads directly from the config. It is excluded from the
	// serialized result for the same reason as the tokenizer flag: Node's startup settings map does
	// not contain this key, and adding it there made the command-line differential disagree with
	// Node in four scenarios before this was split out.
	ImportDomainsWhitelist []string `json:"-"`
	// BrowserLaunchApp carries String(getConfigValue('browserLaunch.browser', 'default') ?? ''),
	// which the pinned postSetupTasks reads at src/server-main.js:365 -- NOT through the parser, so
	// it is not one of the resolved options and must not be added to that compared map. It is the
	// label the launch line prints and the key the named-application lookup uses.
	BrowserLaunchApp string `json:"-"`
	// AccessLogEnabled carries logging.enableAccessLog, which the pinned access-log middleware reads
	// at src/middleware/accessLogWriter.js:6 with a default of true. Like the two fields above it is
	// read straight from the config rather than through the startup settings map, so it is excluded
	// from the serialized result.
	AccessLogEnabled bool `json:"-"`
}

type cliOptionKind uint8

const (
	cliBoolean cliOptionKind = iota
	cliString
	cliNumber
	cliArray
)

var cliOptionKinds = map[string]cliOptionKind{
	"global":                      cliBoolean,
	"configPath":                  cliString,
	"enableIPv6":                  cliString,
	"enableIPv4":                  cliString,
	"port":                        cliNumber,
	"dnsPreferIPv6":               cliBoolean,
	"browserLaunchEnabled":        cliBoolean,
	"browserLaunchHostname":       cliString,
	"browserLaunchPort":           cliNumber,
	"browserLaunchAvoidLocalhost": cliBoolean,
	"listen":                      cliBoolean,
	"listenAddressIPv6":           cliString,
	"listenAddressIPv4":           cliString,
	"corsProxy":                   cliBoolean,
	"disableCsrf":                 cliBoolean,
	"ssl":                         cliBoolean,
	"certPath":                    cliString,
	"keyPath":                     cliString,
	"keyPassphrase":               cliString,
	"whitelist":                   cliBoolean,
	"dataRoot":                    cliString,
	"basicAuthMode":               cliBoolean,
	"enableKeepAlive":             cliBoolean,
	"requestProxyEnabled":         cliBoolean,
	"requestProxyUrl":             cliString,
	"requestProxyBypass":          cliArray,
	"heartbeatInterval":           cliNumber,
	"autorun":                     cliBoolean,
	"autorunHostname":             cliString,
	"autorunPortOverride":         cliNumber,
	"avoidLocalhost":              cliBoolean,
}

var parseFloatPrefix = regexp.MustCompile(`^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)`)

// ResolveCommandLine follows the pinned parser after its config/data paths
// have been selected and initialized. It intentionally reports only parsed
// server options; listener binding and startup side effects are separate.
func ResolveCommandLine(options ResolveOptions) (CommandLineResult, error) {
	paths, err := ResolvePaths(options)
	if err != nil {
		return CommandLineResult{}, err
	}

	arguments := parseServerArguments(options.Args)
	config, err := readConfig(paths.ConfigFile)
	if err != nil {
		return CommandLineResult{}, fmt.Errorf("read initialized config file: %w", err)
	}
	defaults := ServerOptions{
		Port: 8000, Listen: false, ListenAddressIPv6: "[::]", ListenAddressIPv4: "0.0.0.0",
		EnableIPv4: true, EnableIPv6: false, DNSPreferIPv6: false, HeartbeatInterval: 0,
		BrowserLaunchEnabled: false, BrowserLaunchHostname: "auto", BrowserLaunchPort: -1,
		BrowserLaunchAvoidLocalhost: false, EnableCorsProxy: false, DisableCsrf: false,
		SSL: false, CertPath: "certs/cert.pem", KeyPath: "certs/privkey.pem", KeyPassphrase: "",
		WhitelistMode: true, BasicAuthMode: false, EnableKeepAlive: false,
		RequestProxyEnabled: false, RequestProxyURL: "", RequestProxyBypass: []any{},
	}
	get := func(cliName, configName string, fallback any, conversion cliOptionKind) any {
		if value, found := arguments[cliName]; found && value != nil {
			return value
		}
		return getConfigValue(config, configName, fallback, conversion)
	}

	ipv4Value := stringToBoolean(get("enableIPv4", "protocol.ipv4", defaults.EnableIPv4, cliString))
	ipv6Value := stringToBoolean(get("enableIPv6", "protocol.ipv6", defaults.EnableIPv6, cliString))
	warnings := OptionWarnings{}
	if !isBooleanAuto(ipv4Value) {
		warnings.InvalidIPv4Protocol = true
		ipv4Value = defaults.EnableIPv4
	}
	if !isBooleanAuto(ipv6Value) {
		warnings.InvalidIPv6Protocol = true
		ipv6Value = defaults.EnableIPv6
	}

	result := ServerOptions{
		Port:                        get("port", "port", defaults.Port, cliNumber),
		Listen:                      get("listen", "listen", defaults.Listen, cliBoolean),
		ListenAddressIPv6:           get("listenAddressIPv6", "listenAddress.ipv6", defaults.ListenAddressIPv6, cliString),
		ListenAddressIPv4:           get("listenAddressIPv4", "listenAddress.ipv4", defaults.ListenAddressIPv4, cliString),
		EnableIPv4:                  ipv4Value,
		EnableIPv6:                  ipv6Value,
		DNSPreferIPv6:               get("dnsPreferIPv6", "dnsPreferIPv6", defaults.DNSPreferIPv6, cliBoolean),
		HeartbeatInterval:           get("heartbeatInterval", "heartbeatInterval", defaults.HeartbeatInterval, cliNumber),
		BrowserLaunchEnabled:        firstNonNull(arguments, []string{"browserLaunchEnabled", "autorun"}, configValue(config, "browserLaunch.enabled", defaults.BrowserLaunchEnabled, cliBoolean)),
		BrowserLaunchHostname:       firstNonNull(arguments, []string{"browserLaunchHostname", "autorunHostname"}, configValue(config, "browserLaunch.hostname", defaults.BrowserLaunchHostname, cliString)),
		BrowserLaunchPort:           firstNonNull(arguments, []string{"browserLaunchPort", "autorunPortOverride"}, configValue(config, "browserLaunch.port", defaults.BrowserLaunchPort, cliNumber)),
		BrowserLaunchAvoidLocalhost: firstNonNull(arguments, []string{"browserLaunchAvoidLocalhost", "avoidLocalhost"}, configValue(config, "browserLaunch.avoidLocalhost", defaults.BrowserLaunchAvoidLocalhost, cliBoolean)),
		EnableCorsProxy:             get("corsProxy", "enableCorsProxy", defaults.EnableCorsProxy, cliBoolean),
		DisableCsrf:                 get("disableCsrf", "disableCsrfProtection", defaults.DisableCsrf, cliBoolean),
		SSL:                         get("ssl", "ssl.enabled", defaults.SSL, cliBoolean),
		CertPath:                    get("certPath", "ssl.certPath", defaults.CertPath, cliString),
		KeyPath:                     get("keyPath", "ssl.keyPath", defaults.KeyPath, cliString),
		KeyPassphrase:               get("keyPassphrase", "ssl.keyPassphrase", defaults.KeyPassphrase, cliString),
		WhitelistMode:               get("whitelist", "whitelistMode", defaults.WhitelistMode, cliBoolean),
		BasicAuthMode:               get("basicAuthMode", "basicAuthMode", defaults.BasicAuthMode, cliBoolean),
		EnableKeepAlive:             get("enableKeepAlive", "enableKeepAlive", defaults.EnableKeepAlive, cliBoolean),
		RequestProxyEnabled:         get("requestProxyEnabled", "requestProxy.enabled", defaults.RequestProxyEnabled, cliBoolean),
		RequestProxyURL:             get("requestProxyUrl", "requestProxy.url", defaults.RequestProxyURL, cliString),
		RequestProxyBypass:          get("requestProxyBypass", "requestProxy.bypass", defaults.RequestProxyBypass, cliArray),
	}
	startupSettings := StartupSettings{
		LegacyCookieSecret:         getConfigValue(config, "cookieSecret", nil, cliString),
		SessionTimeout:             getConfigValue(config, "sessionTimeout", -1, cliNumber),
		EnableUserAccounts:         getConfigValue(config, "enableUserAccounts", false, cliBoolean),
		EnableDiscreetLogin:        getConfigValue(config, "enableDiscreetLogin", false, cliBoolean),
		SecurityOverride:           getConfigValue(config, "securityOverride", false, cliBoolean),
		PerUserBasicAuth:           getConfigValue(config, "perUserBasicAuth", false, cliBoolean),
		PreferRealIPHeader:         getConfigValue(config, "rateLimiting.preferRealIpHeader", false, cliBoolean),
		BasicAuthMaxAttempts:       getConfigValue(config, "rateLimiting.basicAuthMaxAttempts", 5, cliNumber),
		AccountsLoginMaxAttempts:   getConfigValue(config, "rateLimiting.accountsLoginMaxAttempts", 5, cliNumber),
		AccountsRecoverMaxAttempts: getConfigValue(config, "rateLimiting.accountsRecoverMaxAttempts", 5, cliNumber),
		AccountsResetMaxAttempts:   getConfigValue(config, "rateLimiting.accountsResetMaxAttempts", 5, cliNumber),
		AllowFullDataBackup:        getConfigValue(config, "backups.allowFullDataBackup", true, cliBoolean),
		AllowKeysExposure:          getConfigValue(config, "allowKeysExposure", false, cliBoolean),
		ExtensionsEnabled:          getConfigValue(config, "extensions.enabled", true, cliBoolean),
		ExtensionsAutoUpdate:       resolveAutoUpdateOption(config),
		RequestCompressionEnabled:  getConfigValue(config, "performance.requestCompression.enabled", false, cliBoolean),
		RequestCompressionMin:      getConfigValue(config, "performance.requestCompression.minPayloadSize", "256kb", cliString),
		RequestCompressionMax:      getConfigValue(config, "performance.requestCompression.maxPayloadSize", "8mb", cliString),
		RequestCompressionTimeout:  getConfigValue(config, "performance.requestCompression.timeout", 3000, cliNumber),
		CorsEnabled:                getConfigValue(config, "cors.enabled", true, cliBoolean),
		CorsOrigin:                 getConfigValue(config, "cors.origin", "null", cliString),
		CorsMethods:                getConfigValue(config, "cors.methods", []any{"OPTIONS"}, cliArray),
		CorsAllowedHeaders:         getConfigValue(config, "cors.allowedHeaders", []any{}, cliArray),
		CorsExposedHeaders:         getConfigValue(config, "cors.exposedHeaders", []any{}, cliArray),
		CorsCredentials:            getConfigValue(config, "cors.credentials", false, cliBoolean),
		CorsMaxAge:                 getConfigValue(config, "cors.maxAge", nil, cliNumber),
		ThumbnailDimensionsBG:      getConfigValue(config, "thumbnails.dimensions.bg", []any{160, 90}, cliArray),
		ThumbnailDimensionsAvatar:  getConfigValue(config, "thumbnails.dimensions.avatar", []any{96, 144}, cliArray),
		ThumbnailDimensionsPersona: getConfigValue(config, "thumbnails.dimensions.persona", []any{96, 144}, cliArray),
		ThumbnailsEnabled:          getConfigValue(config, "thumbnails.enabled", true, cliBoolean),
		ThumbnailsFormat:           getConfigValue(config, "thumbnails.format", "jpg", cliString),
		ThumbnailsQuality:          getConfigValue(config, "thumbnails.quality", 95, cliNumber),
		ThumbnailDimensionsSet:     true,
		ForwardedXRealIP:           getConfigValue(config, "forwardedHeaders.xRealIp", true, cliBoolean),
		ForwardedCFConnectingIP:    getConfigValue(config, "forwardedHeaders.cfConnectingIp", false, cliBoolean),
		ForwardedXForwardedFor:     getConfigValue(config, "forwardedHeaders.xForwardedFor", true, cliBoolean),
		EnableForwardedWhitelist:   getConfigValue(config, "enableForwardedWhitelist", false, cliBoolean),
		Whitelist:                  getConfigValue(config, "whitelist", []any{}, cliArray),
		WhitelistDockerHosts:       getConfigValue(config, "whitelistDockerHosts", true, cliBoolean),
		HostWhitelistEnabled:       getConfigValue(config, "hostWhitelist.enabled", false, cliBoolean),
		HostWhitelistScan:          getConfigValue(config, "hostWhitelist.scan", false, cliBoolean),
		HostWhitelistHosts:         getConfigValue(config, "hostWhitelist.hosts", []any{}, cliArray),
		BasicAuthUsername:          getConfigValue(config, "basicAuthUser.username", "", cliString),
		BasicAuthPassword:          getConfigValue(config, "basicAuthUser.password", "", cliString),
		SkipContentCheck:           getConfigValue(config, "skipContentCheck", false, cliBoolean),
		UseDiskCache:               getConfigValue(config, "performance.useDiskCache", true, cliBoolean),
		SettingsBackupRetention:    getConfigValue(config, "backups.common.numberOfBackups", 50, cliNumber),
	}
	return CommandLineResult{Paths: paths, Options: result, StartupSettings: startupSettings, Warnings: warnings, TokenizersDownloadAllowed: tokenizersDownloadAllowed(config), ImportDomainsWhitelist: importDomainsWhitelist(config), BrowserLaunchApp: browserLaunchApp(config), AccessLogEnabled: accessLogEnabled(config)}, nil
}

// browserLaunchApp resolves browserLaunch.browser the way the pinned
// postSetupTasks does (src/server-main.js:365):
// String(getConfigValue('browserLaunch.browser', 'default') ?? empty).
//
// The nullish fallback is not decoration: an explicit YAML `browser: null` yields the
// empty string, not "null", while a boolean or a list is stringified with
// JavaScript's String() rules -- which is why jsString is reused here rather
// than a type assertion that would silently drop an unusual value.
func browserLaunchApp(config map[string]any) string {
	value := getConfigValue(config, "browserLaunch.browser", "default", cliString)
	if value == nil {
		return ""
	}
	return jsString(value)
}

// accessLogEnabled resolves logging.enableAccessLog with the pinned default of
// true (src/middleware/accessLogWriter.js:6).
func accessLogEnabled(config map[string]any) bool {
	return jsBoolean(getConfigValue(config, "logging.enableAccessLog", true, cliBoolean))
}

// importDomainsWhitelist resolves whitelistImportDomains the way the pinned
// src/endpoints/content-manager.js reads it: a config key whose DEFAULT is the four-host list. It is
// reported separately, not through the startup settings map, because Node's map does not contain
// this key and putting it there made the command-line differential disagree in four scenarios.
func importDomainsWhitelist(config map[string]any) []string {
	defaultDomains := []any{"localhost", "cdn.discordapp.com", "files.catbox.moe", "raw.githubusercontent.com"}
	value := getConfigValue(config, "whitelistImportDomains", defaultDomains, cliArray)
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	domains := make([]string, 0, len(items))
	for _, item := range items {
		if domain, ok := item.(string); ok {
			domains = append(domains, domain)
		}
	}
	return domains
}

// tokenizersDownloadAllowed resolves enableDownloadableTokenizers the way the pinned
// src/endpoints/tokenizers.js reads it: a config key with a default of true, which is NOT part
// of the serialized startup settings map. It is reported separately so it cannot leak into that
// map, whose contents the command-line differential compares against Node.
func tokenizersDownloadAllowed(config map[string]any) *bool {
	allowed, ok := getConfigValue(config, "enableDownloadableTokenizers", true, cliBoolean).(bool)
	if !ok {
		return nil
	}
	return &allowed
}

func parseServerArguments(args []string) map[string]any {
	values := make(map[string]any)
	for index := 0; index < len(args); index++ {
		argument := args[index]
		if argument == "--" {
			break
		}
		if !strings.HasPrefix(argument, "--") {
			continue
		}
		name, raw, inline := strings.Cut(strings.TrimPrefix(argument, "--"), "=")
		if strings.HasPrefix(name, "no-") && !inline {
			negated := camelOptionName(strings.TrimPrefix(name, "no-"))
			if cliOptionKinds[negated] == cliBoolean {
				values[negated] = false
			}
			continue
		}
		canonical := camelOptionName(name)
		kind, known := cliOptionKinds[canonical]
		if !known {
			continue
		}
		switch kind {
		case cliBoolean:
			if !inline && index+1 < len(args) && (strings.EqualFold(args[index+1], "true") || strings.EqualFold(args[index+1], "false")) {
				values[canonical] = strings.EqualFold(args[index+1], "true")
				index++
			} else if inline {
				values[canonical] = strings.EqualFold(raw, "true")
			} else {
				values[canonical] = true
			}
		case cliArray:
			items := []any{}
			if inline {
				items = append(items, yargsArrayValue(raw))
			} else {
				for index+1 < len(args) && !strings.HasPrefix(args[index+1], "--") {
					index++
					items = append(items, yargsArrayValue(args[index]))
				}
			}
			if previous, ok := values[canonical].([]any); ok {
				values[canonical] = append(previous, items...)
			} else {
				values[canonical] = items
			}
		case cliString:
			if inline {
				values[canonical] = raw
			} else if index+1 < len(args) && !strings.HasPrefix(args[index+1], "--") {
				index++
				values[canonical] = args[index]
			} else {
				values[canonical] = nil
			}
		case cliNumber:
			if !inline && index+1 < len(args) && !strings.HasPrefix(args[index+1], "--") {
				index++
				raw = args[index]
				inline = true
			}
			if inline {
				if raw == "" {
					values[canonical] = float64(0)
				} else if number, err := strconv.ParseFloat(raw, 64); err == nil {
					values[canonical] = number
				} else {
					values[canonical] = math.NaN()
				}
			}
		}
	}
	return values
}

func camelOptionName(name string) string {
	parts := strings.Split(name, "-")
	for index := 1; index < len(parts); index++ {
		if parts[index] != "" {
			parts[index] = strings.ToUpper(parts[index][:1]) + parts[index][1:]
		}
	}
	return strings.Join(parts, "")
}

func yargsArrayValue(value string) any {
	if number, err := strconv.ParseFloat(value, 64); err == nil {
		return number
	}
	return value
}

func readConfig(configPath string) (map[string]any, error) {
	body, err := os.ReadFile(configPath)
	if err != nil {
		return nil, err
	}
	var config map[string]any
	if err := yaml.Unmarshal(body, &config); err != nil {
		return nil, err
	}
	if config == nil {
		config = make(map[string]any)
	}
	return config, nil
}

func getConfigValue(config map[string]any, key string, fallback any, conversion cliOptionKind) any {
	environmentKey := "SILLYTAVERN_" + strings.ToUpper(strings.ReplaceAll(key, ".", "_"))
	var value any
	if environmentValue, found := os.LookupEnv(environmentKey); found {
		value = environmentValue
		if _, isArrayDefault := fallback.([]any); isArrayDefault {
			var parsed any
			if err := json.Unmarshal([]byte(environmentValue), &parsed); err != nil {
				value = fallback
			} else {
				value = parsed
			}
		}
	} else if configured, found := dottedValue(config, key); found {
		value = configured
	} else {
		value = fallback
	}

	switch conversion {
	case cliBoolean:
		return jsBoolean(value)
	case cliNumber:
		number, ok := parseJSFloat(value)
		if !ok {
			return fallback
		}
		return number
	default:
		return value
	}
}

// resolveAutoUpdateOption reads AutoUpdateKey and resolves it without jsBoolean.
//
// The inherited keys (extensions.autoUpdate, enableServerPluginsAutoUpdate) are deliberately NOT read here:
// they arrive `true` from the pinned fresh config and would enable updates nobody asked for. They stay
// available for reporting, and the settings route reports THIS value.
func resolveAutoUpdateOption(config map[string]any) bool {
	raw, present := dottedValue(config, AutoUpdateKey)
	return ResolveAutoUpdate(raw, present)
}
func configValue(config map[string]any, key string, fallback any, conversion cliOptionKind) any {
	return getConfigValue(config, key, fallback, conversion)
}

func dottedValue(config map[string]any, key string) (any, bool) {
	var current any = config
	for _, part := range strings.Split(key, ".") {
		mapping, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = mapping[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func jsBoolean(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "true":
			return true
		case "false":
			return false
		default:
			return typed != ""
		}
	case int:
		return typed != 0
	case int64:
		return typed != 0
	case uint64:
		return typed != 0
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	default:
		return true
	}
}

func parseJSFloat(value any) (float64, bool) {
	text := strings.TrimLeft(jsString(value), " \t\n\r\v\f")
	match := parseFloatPrefix.FindString(text)
	if match == "" {
		return 0, false
	}
	number, err := strconv.ParseFloat(match, 64)
	return number, err == nil || math.IsInf(number, 0)
}

func jsString(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(typed)
	case string:
		return typed
	case []any:
		parts := make([]string, len(typed))
		for index, item := range typed {
			if item != nil {
				parts[index] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return fmt.Sprint(value)
	}
}

func stringToBoolean(value any) any {
	text := strings.ToLower(strings.TrimSpace(jsString(value)))
	switch text {
	case "true":
		return true
	case "false":
		return false
	default:
		return value
	}
}

func isBooleanAuto(value any) bool {
	if _, ok := value.(bool); ok {
		return true
	}
	text, ok := value.(string)
	return ok && text == "auto"
}

func firstNonNull(arguments map[string]any, keys []string, fallback any) any {
	for _, key := range keys {
		if value, found := arguments[key]; found && value != nil {
			return value
		}
	}
	return fallback
}
