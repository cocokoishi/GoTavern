# Pinned configuration inventory

Baseline: SillyTavern 1.19.0 at `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Defaults are read from `default/config.yaml`; CLI options and key migrations are read from `src/command-line.js` and `src/config-init.js`.

Default leaf keys inventoried: **116**. CLI options inventoried: **31**.

Pinned `getConfigValue(key, default, type)` first reads `SILLYTAVERN_` plus the uppercased key with dots changed to underscores, then falls back to YAML. A present environment variable takes precedence over YAML. Type conversion is call-site-specific. The CLI parser applies explicit command-line values before config lookups for fields listed below.

## Keys whose GoTavern status is NOT "it just works"

This table lists pinned's keys and defaults. It does not, on its own, say what GoTavern does with each one — and three
families used to be accepted and then silently ignored, which is the failure AGENTS.md rule 18 forbids. Their true
state is recorded here so a reader does not have to infer it from the key's presence:

| Config family | GoTavern status | Evidence |
|---|---|---|
| `cacheBuster.enabled`, `cacheBuster.userAgentPattern` | **implemented** | the middleware is mounted where pinned mounts it (`app.get('/', …)`, `src/server-main.js:214`, which Express also routes `HEAD` to) plus the three direct `bust` calls; `internal/server/cache_buster.go`, `internal/server/cache_buster_test.go`. Reproduces two pinned quirks rather than simplifying them: the pattern is read with **no** type converter and tested for JavaScript *truthiness* (`Boolean("false")` is true, unlike `toBoolean("false")`), and the once-per-key set is consumed **before** the header decision. The header value is the quoted `"cache"` |
| `sso.autheliaAuth`, `sso.authentikAuth` | **NOT implemented — and now warned** | SSO auto-login does not exist in GoTavern; a truthy switch prints a named stderr warning saying so and saying the setting has no effect (`internal/commandline/unimplemented_config.go`). `sso.trustedProxies` alone deliberately does not warn: its shipped default is truthy and it is inert in pinned too unless a method is enabled, so warning on it would fire on every stock boot |
| `privateAddressWhitelist.*` | **implemented** (was `NOT implemented — and now warned`) | the filter is installed on the single outbound policy (`internal/outbound/privatefilter.go`), wired at boot before the provider proxy (`internal/app/server.go`), gated on `enabled`. It blocks at CONNECT time on the DNS-RESOLVED address, validates every redirect hop, honours `allowUnresolvedHosts`, accepts `allowedRanges` as CIDR **and** as `ip-matching` wildcard/range/mask forms (32 probe-derived grammar rows), and honours both log switches. Each refusal assertion is a REQUEST COUNT (rule 17). **THE WARNING THAT USED TO FIRE HERE IS RETIRED**, because its sentence ("GoTavern does NOT implement the private address filter") became false and keeping it would be the same defect in the other direction. **ONE DELIBERATE DIVERGENCE, recorded as a product decision (AGENTS.md boundary 5):** pinned's `ip-matching` answers `false` for `10.0.0.0/8` against `::ffff:10.0.0.1` — MEASURED by probing the package — so pinned lets a v4-mapped-v6 address past every IPv4 range *and* every IPv4 whitelist entry, an inherited SSRF bypass. GoTavern canonicalises the mapped form and is therefore STRICTER than pinned here; the whitelist keeps both readings so an existing `::ffff:0:0/96` entry is not broken. **A parity quirk worth knowing:** `allowedRanges: []` cannot mean "allow nothing", because pinned's `_.defaultsDeep` refills the empty array with the default loopback pair, and GoTavern reproduces that; the way to narrow to nothing is a NON-array value, which is pinned's own shape rule |

| `enableKeepAlive` / `--enableKeepAlive` | **implemented** (was accepted and ignored) | `src/command-line.js:323` (default `false`, `:80`) is installed on the provider transport as `DisableKeepAlives = !enableKeepAlive`, which is what `new http.Agent({keepAlive: cliArgs.enableKeepAlive})` does at `src/server-main.js:100-101`. Production transport only (`internal/outbound/transport.go`, wired at `internal/app/transport.go`); the byte-exact oracle client is untouched (rule 30). Test: `TestProductionTransportKeepAliveFollowsTheConfigKey` counts connections AT THE PEER - 2 requests must open 2 connections when disabled and reuse 1 when enabled |
| `dnsPreferIPv6` / `--dnsPreferIPv6` | **implemented** (was accepted and ignored) | `src/server-main.js:465-477` calls `dns.setDefaultResultOrder('ipv6first' / 'ipv4first')` from the startup chain (`:481`), with the flag resolved at `src/command-line.js:309` and defaulted `false` (`:66`). The Go equivalent is `internal/outbound/dnsorder.go`: resolve once, order the addresses with the preferred family first, dial in that order - because Go has no dialer knob for it (`net` re-sorts a multi-family answer with `sortByRFC6724`). Test: `TestProductionTransportDNSOrderPrefersTheConfiguredFamily` runs one listener per family on ONE port with the resolver seam listing IPv6 FIRST, and asserts which listener accepted the connection |
| `logging.minLogLevel` | **implemented for the console calls made while serving** (was accepted and ignored) | `src/util.js:1136-1143` replaces `console.debug/info/warn/error` with no-ops unless `logLevel <= LEVEL`, at the END of the startup chain (`src/server-main.js:448`), so startup lines are NOT gated and are left alone here. `internal/server/console.go` gates the post-startup calls that go through those levels: the access log's `console.info`/`console.error` (`src/middleware/accessLogWriter.js:44-47`) and the host-whitelist `console.warn` (`src/middleware/hostWhitelist.js:29-36`). The value is kept as a FLOAT because the pinned comparison is numeric (`2.5` silences WARN). The FILE line of the access log is deliberately not gated. Tests: `TestConsoleMinLogLevelGatesTheAccessLogConsoleLineOnly`, `TestConsoleMinLogLevelGatesWarningsButNotConsoleLog`, `TestConsoleMinLogLevelResolvesLikeSetupLogLevel`. The two account-code lines stay ungated because pinned uses `console.log`, which setupLogLevel does not replace |
| `requestOverrides` | **implemented** (was parsed and explicitly not applied) | `src/additional-headers.js:202-210` plus the `Object.assign` at `:251-262`: the first entry whose `hosts` includes `new URL(server).host` (lowercase, default port dropped), assigned LAST so it overrides the type's headers including `Authorization`/`Content-Type`. Applied at every Go call site that reproduces a pinned `setAdditionalHeaders`/`getOverrideHeaders` call: text-completions status/props/generate (+ the kobold abort), tabby download, kobold status/embed/generate/transcribe, and `/api/search/koboldcpp`. `internal/server/request_overrides.go`. Test: `TestRequestOverridesReachTheProviderAndWin` reads the headers the PEER received, including the precedence and first-match rows |
| `openai.randomizeUserId` | **implemented** (was accepted and ignored) | `src/endpoints/backends/chat-completions.js:2296-2298` sets `bodyParams['user'] = uuidv4()` inside the OPENAI arm only, default `false` (`default/config.yaml:326-327`). `internal/server/openai_chat.go` adds a fresh lowercase RFC 4122 v4 UUID as the body's LAST member (`...bodyParams` is the final spread at `:2652-2669`); `internal/server/uuid.go` builds the shape from `crypto/rand`. No dependency added. Test: `TestOpenAIRandomizeUserIdSendsAPinnedUUIDv4Member` asserts the shape, the position, freshness per request, absence when off, and absence on another source with the flag on |
| `performance.memoryCacheCapacity` | **NOT implemented - there is no cache for it to bound** | see "Recorded boundaries" below |
| `gemini.enableSystemPromptCache` | **NOT implemented - its pinned gate is an unimplemented probe** | see "Recorded boundaries" below |

## Default YAML leaf values

| Config key | Pinned default | Static read sites found |
|---|---|---|
| `dataRoot` | `"./data"` | `src/command-line.js:290` |
| `listen` | `false` | `src/command-line.js:304` |
| `listenAddress.ipv4` | `"0.0.0.0"` | `src/command-line.js:306` |
| `listenAddress.ipv6` | `"[::]"` | `src/command-line.js:305` |
| `protocol.ipv4` | `true` | `src/command-line.js:307` |
| `protocol.ipv6` | `false` | `src/command-line.js:308` |
| `dnsPreferIPv6` | `false` | `src/command-line.js:309` |
| `browserLaunch.enabled` | `true` | `src/command-line.js:311` |
| `browserLaunch.browser` | `"default"` | `src/server-main.js:365` |
| `browserLaunch.hostname` | `"auto"` | `src/command-line.js:312` |
| `browserLaunch.port` | `-1` | `src/command-line.js:313` |
| `browserLaunch.avoidLocalhost` | `false` | `src/command-line.js:314` |
| `port` | `8000` | `src/command-line.js:303` |
| `heartbeatInterval` | `0` | `src/command-line.js:310` |
| `enableKeepAlive` | `false` | `src/command-line.js:323` |
| `ssl.enabled` | `false` | `src/command-line.js:317` |
| `ssl.certPath` | `"./certs/cert.pem"` | `src/command-line.js:318` |
| `ssl.keyPath` | `"./certs/privkey.pem"` | `src/command-line.js:319` |
| `ssl.keyPassphrase` | `""` | `src/command-line.js:320` |
| `whitelistMode` | `true` | `src/command-line.js:321` |
| `enableForwardedWhitelist` | `true` | `src/middleware/whitelist.js:13` |
| `whitelist` | `["::1","127.0.0.1"]` | `src/middleware/whitelist.js:16` |
| `whitelistDockerHosts` | `true` | `src/middleware/whitelist.js:14` |
| `basicAuthMode` | `false` | `src/command-line.js:322` |
| `basicAuthUser.username` | `"user"` | `src/middleware/basicAuth.js:33`, `src/users.js:187` |
| `basicAuthUser.password` | `"password"` | `src/middleware/basicAuth.js:34`, `src/users.js:188` |
| `enableCorsProxy` | `false` | `src/command-line.js:315` |
| `cors.enabled` | `true` | `src/server-main.js:114` |
| `cors.origin` | `["null"]` | `src/server-main.js:116` |
| `cors.methods` | `["OPTIONS"]` | `src/server-main.js:117` |
| `cors.allowedHeaders` | `[]` | `src/server-main.js:118` |
| `cors.exposedHeaders` | `[]` | `src/server-main.js:119` |
| `cors.credentials` | `false` | `src/server-main.js:120` |
| `cors.maxAge` | `null` | `src/server-main.js:121` |
| `requestProxy.enabled` | `false` | `src/command-line.js:324` |
| `requestProxy.url` | `"socks5://username:password@example.com:1080"` | `src/command-line.js:325` |
| `requestProxy.bypass` | `["localhost","127.0.0.1"]` | `src/command-line.js:326` |
| `enableUserAccounts` | `false` | `src/endpoints/settings.js:16`, `src/middleware/basicAuth.js:14`, `src/users.js:29` |
| `enableDiscreetLogin` | `false` | `src/endpoints/users-public.js:10` |
| `perUserBasicAuth` | `false` | `src/middleware/basicAuth.js:13`, `src/users.js:32`, `src/users.js:181` |
| `sso.autheliaAuth` | `false` | `src/users.js:30` |
| `sso.authentikAuth` | `false` | `src/users.js:31` |
| `sso.trustedProxies` | `["::1","127.0.0.1"]` | `src/users.js:34` |
| `hostWhitelist.enabled` | `false` | `src/middleware/hostWhitelist.js:8` |
| `hostWhitelist.scan` | `true` | `src/middleware/hostWhitelist.js:10` |
| `hostWhitelist.hosts` | `[]` | `src/middleware/hostWhitelist.js:9` |
| `privateAddressWhitelist.enabled` | `false` | `src/server-main.js:340` |
| `privateAddressWhitelist.allowUnresolvedHosts` | `false` | `src/server-main.js:344` |
| `privateAddressWhitelist.log.blockedRequests` | `true` | `src/server-main.js:342` |
| `privateAddressWhitelist.log.allowedRequests` | `false` | `src/server-main.js:343` |
| `privateAddressWhitelist.allowedRanges` | `["127.0.0.0/8","::1/128"]` | `src/server-main.js:341` |
| `sessionTimeout` | `-1` | `src/users.js:621` |
| `disableCsrfProtection` | `false` | `src/command-line.js:316` |
| `securityOverride` | `false` | `src/users.js:141` |
| `logging.enableAccessLog` | `true` | `src/middleware/accessLogWriter.js:6` |
| `logging.minLogLevel` | `0` | `src/util.js:1137` |
| `rateLimiting.preferRealIpHeader` | `false` | `src/endpoints/users-private.js:16`, `src/endpoints/users-public.js:11`, `src/middleware/basicAuth.js:15` |
| `rateLimiting.basicAuthMaxAttempts` | `5` | `src/middleware/basicAuth.js:16` |
| `rateLimiting.accountsLoginMaxAttempts` | `5` | `src/endpoints/users-public.js:12` |
| `rateLimiting.accountsRecoverMaxAttempts` | `5` | `src/endpoints/users-public.js:13` |
| `rateLimiting.accountsResetMaxAttempts` | `5` | `src/endpoints/users-private.js:15` |
| `forwardedHeaders.xRealIp` | `true` | `src/express-common.js:39` |
| `forwardedHeaders.xForwardedFor` | `true` | `src/express-common.js:41` |
| `forwardedHeaders.cfConnectingIp` | `false` | `src/express-common.js:40` |
| `backups.allowFullDataBackup` | `true` | `src/endpoints/users-private.js:158` |
| `backups.common.numberOfBackups` | `50` | `src/util.js:657` |
| `backups.chat.enabled` | `true` | `src/endpoints/chats.js:27` |
| `backups.chat.checkIntegrity` | `true` | `src/endpoints/chats.js:30` |
| `backups.chat.maxTotalBackups` | `-1` | `src/endpoints/chats.js:28` |
| `backups.chat.throttleInterval` | `10000` | `src/endpoints/chats.js:29` |
| `thumbnails.enabled` | `true` | `src/endpoints/thumbnails.js:20` |
| `thumbnails.format` | `"jpg"` | `src/endpoints/thumbnails.js:22` |
| `thumbnails.quality` | `95` | `src/endpoints/thumbnails.js:21` |
| `thumbnails.dimensions.bg` | `[160,90]` | `src/endpoints/image-metadata.js:42` |
| `thumbnails.dimensions.avatar` | `[96,144]` | `src/endpoints/image-metadata.js:43` |
| `thumbnails.dimensions.persona` | `[96,144]` | `src/endpoints/image-metadata.js:44` |
| `performance.lazyLoadCharacters` | `false` | `src/endpoints/characters.js:35` |
| `performance.memoryCacheCapacity` | `"100mb"` | `src/endpoints/characters.js:30` |
| `performance.useDiskCache` | `true` | `src/endpoints/characters.js:36` |
| `performance.requestCompression.enabled` | `false` | `src/endpoints/settings.js:17` |
| `performance.requestCompression.minPayloadSize` | `"256kb"` | `src/endpoints/settings.js:18` |
| `performance.requestCompression.maxPayloadSize` | `"8mb"` | `src/endpoints/settings.js:19` |
| `performance.requestCompression.timeout` | `4000` | `src/endpoints/settings.js:20` |
| `cacheBuster.enabled` | `false` | `src/middleware/cacheBuster.js:28` |
| `cacheBuster.userAgentPattern` | `""` | `src/middleware/cacheBuster.js:29` |
| `allowKeysExposure` | `false` | `src/endpoints/secrets.js:108` |
| `skipContentCheck` | `false` | `src/endpoints/content-manager.js:217` |
| `whitelistImportDomains` | `["localhost","cdn.discordapp.com","files.catbox.moe","raw.githubusercontent.com"]` | `src/endpoints/content-manager.js:22` |
| `requestOverrides` | `[]` | `src/additional-headers.js:203` |
| `extensions.enabled` | `true` | `src/endpoints/extensions.js:73`, `src/endpoints/settings.js:14` |
| `extensions.autoUpdate` | `true` | `src/endpoints/settings.js:15` |
| `extensions.models.autoDownload` | `true` | `src/transformers.js:136` |
| `extensions.models.classification` | `"Cohee/distilbert-base-uncased-go-emotions-onnx"` | not found by literal `getConfigValue` scan |
| `extensions.models.captioning` | `"Xenova/vit-gpt2-image-captioning"` | not found by literal `getConfigValue` scan |
| `extensions.models.embedding` | `"Cohee/jina-embeddings-v2-base-en"` | `src/endpoints/vectors.js:229` |
| `extensions.models.speechToText` | `"Xenova/whisper-small"` | not found by literal `getConfigValue` scan |
| `extensions.models.textToSpeech` | `"Xenova/speecht5_tts"` | not found by literal `getConfigValue` scan |
| `git.backend` | `"auto"` | `src/endpoints/extensions.js:12` |
| `enableDownloadableTokenizers` | `true` | `src/endpoints/tokenizers.js:60` |
| `promptPlaceholder` | `"[Start a new chat]"` | `src/prompt-converters.js:4` |
| `openai.randomizeUserId` | `false` | `src/endpoints/backends/chat-completions.js:2296` |
| `openai.captionSystemPrompt` | `""` | `src/endpoints/openai.js:131` |
| `deepl.formality` | `"default"` | `src/endpoints/translate.js:218` |
| `mistral.enablePrefix` | `false` | `src/prompt-converters.js:709` |
| `ollama.keepAlive` | `-1` | `src/endpoints/backends/text-completions.js:386` |
| `ollama.batchSize` | `-1` | `src/endpoints/backends/text-completions.js:387` |
| `claude.enableSystemPromptCache` | `false` | `src/endpoints/backends/chat-completions.js:107` |
| `claude.cachingAtDepth` | `-1` | `src/endpoints/backends/chat-completions.js:109` |
| `claude.extendedTTL` | `false` | `src/endpoints/backends/chat-completions.js:106` |
| `claude.enableAdaptiveThinking` | `false` | `src/endpoints/backends/chat-completions.js:112` |
| `gemini.apiVersion` | `"v1beta"` | `src/endpoints/backends/chat-completions.js:679`, `src/endpoints/backends/chat-completions.js:1911`, `src/endpoints/google.js:223` |
| `gemini.thoughtSignatures` | `true` | `src/prompt-converters.js:34` |
| `gemini.enableSystemPromptCache` | `false` | `src/endpoints/backends/chat-completions.js:2370` |
| `gemini.image.personGeneration` | `"allow_adult"` | `src/endpoints/google.js:442` |
| `enableServerPlugins` | `false` | `src/plugin-loader.js:10` |
| `enableServerPluginsAutoUpdate` | `true` | `src/plugin-loader.js:11` |

## CLI options

The parser derives additional operational defaults in `CommandLineParser.getDefaultConfig()` and `parse()`. This option list inventories declarations; exact precedence and derived values still require probes.

| Option | Type | Description | Source |
|---|---|---|---|
| `--autorun` | `"boolean"` | DEPRECATED: Use "browserLaunchEnabled" instead. | [src/command-line.js:247](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L247) |
| `--autorunHostname` | `"string"` | DEPRECATED: Use "browserLaunchHostname" instead. | [src/command-line.js:252](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L252) |
| `--autorunPortOverride` | `"number"` | DEPRECATED: Use "browserLaunchPort" instead. | [src/command-line.js:257](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L257) |
| `--avoidLocalhost` | `"boolean"` | DEPRECATED: Use "browserLaunchAvoidLocalhost" instead. | [src/command-line.js:262](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L262) |
| `--basicAuthMode` | `"boolean"` | Enables basic authentication | [src/command-line.js:217](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L217) |
| `--browserLaunchAvoidLocalhost` | `"boolean"` | Avoids using 'localhost' for browser launch in auto mode. Use if you don't have 'localhost' in your hosts file | [src/command-line.js:157](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L157) |
| `--browserLaunchEnabled` | `"boolean"` | Automatically launch SillyTavern in the browser | [src/command-line.js:142](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L142) |
| `--browserLaunchHostname` | `"string"` | Sets the browser launch hostname, best left on 'auto'. Use values like 'localhost', 'st.example.com' | [src/command-line.js:147](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L147) |
| `--browserLaunchPort` | `"number"` | Overrides the port for browser launch with open your browser with this port and ignore what port the server is running on. -1 is use server port | [src/command-line.js:152](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L152) |
| `--certPath` | `"string"` | Path to SSL certificate file | [src/command-line.js:192](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L192) |
| `--configPath` | `"string"` | Path to the config file (only for standalone mode) | [src/command-line.js:117](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L117) |
| `--corsProxy` | `"boolean"` | Enables CORS proxy | [src/command-line.js:177](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L177) |
| `--dataRoot` | `"string"` | Root directory for data storage (only for standalone mode) | [src/command-line.js:212](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L212) |
| `--disableCsrf` | `"boolean"` | Disables CSRF protection - NOT RECOMMENDED | [src/command-line.js:182](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L182) |
| `--dnsPreferIPv6` | `"boolean"` | Prefers IPv6 for DNS You should probably have the enabled if you're on an IPv6 only network | [src/command-line.js:137](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L137) |
| `--enableIPv4` | `"string"` | Enables IPv4 protocol | [src/command-line.js:127](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L127) |
| `--enableIPv6` | `"string"` | Enables IPv6 protocol | [src/command-line.js:122](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L122) |
| `--enableKeepAlive` | `"boolean"` | Enable HTTP/HTTPS keep-alive globally | [src/command-line.js:222](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L222) |
| `--global` | `"boolean"` | Use global data and config paths instead of the server directory | [src/command-line.js:112](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L112) |
| `--heartbeatInterval` | `"number"` | Interval in seconds to write a heartbeat file. 0 to disable. | [src/command-line.js:241](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L241) |
| `--keyPassphrase` | `"string"` | Passphrase for the SSL private key | [src/command-line.js:202](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L202) |
| `--keyPath` | `"string"` | Path to SSL private key file | [src/command-line.js:197](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L197) |
| `--listen` | `"boolean"` | Whether to listen on all network interfaces | [src/command-line.js:162](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L162) |
| `--listenAddressIPv4` | `"string"` | Specific IPv4 address to listen to | [src/command-line.js:172](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L172) |
| `--listenAddressIPv6` | `"string"` | Specific IPv6 address to listen to | [src/command-line.js:167](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L167) |
| `--port` | `"number"` | Sets the server listening port | [src/command-line.js:132](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L132) |
| `--requestProxyBypass` | `"array"` | Request proxy bypass list (space separated list of hosts) | [src/command-line.js:237](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L237) |
| `--requestProxyEnabled` | `"boolean"` | Enables a use of proxy for outgoing requests | [src/command-line.js:227](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L227) |
| `--requestProxyUrl` | `"string"` | Request proxy URL (HTTP or SOCKS protocols) | [src/command-line.js:232](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L232) |
| `--ssl` | `"boolean"` | Enables SSL | [src/command-line.js:187](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L187) |
| `--whitelist` | `"boolean"` | Enables whitelist mode | [src/command-line.js:207](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/command-line.js#L207) |

## Config migrations

Migrations run in `addMissingConfigValues()` before missing defaults are added. The same old-to-new environment-variable names are redirected when the old environment variable is present and the new one is absent. The pinned Node probe records fresh-file YAML bytes, a legacy config with key migrations/default insertion/unknown fields, and a legacy environment variable migration.

| Legacy key | New key | Transform recorded from source |
|---|---|---|
| `disableThumbnails` | `thumbnails.enabled` | (value) => !value |
| `thumbnailsQuality` | `thumbnails.quality` | (value) => value |
| `avatarThumbnailsPng` | `thumbnails.format` | (value) => (value ? 'png' : 'jpg') |
| `disableChatBackup` | `backups.chat.enabled` | (value) => !value |
| `numberOfBackups` | `backups.common.numberOfBackups` | (value) => value |
| `maxTotalChatBackups` | `backups.chat.maxTotalBackups` | (value) => value |
| `chatBackupThrottleInterval` | `backups.chat.throttleInterval` | (value) => value |
| `enableExtensions` | `extensions.enabled` | (value) => value |
| `enableExtensionsAutoUpdate` | `extensions.autoUpdate` | (value) => value |
| `extras.disableAutoDownload` | `extensions.models.autoDownload` | (value) => !value |
| `extras.classificationModel` | `extensions.models.classification` | (value) => value |
| `extras.captioningModel` | `extensions.models.captioning` | (value) => value |
| `extras.embeddingModel` | `extensions.models.embedding` | (value) => value |
| `extras.speechToTextModel` | `extensions.models.speechToText` | (value) => value |
| `extras.textToSpeechModel` | `extensions.models.textToSpeech` | (value) => value |
| `minLogLevel` | `logging.minLogLevel` | (value) => value |
| `cardsCacheCapacity` | `performance.memoryCacheCapacity` | (value) => `${value}mb` |
| `cookieSecret` | `cookieSecret` | remove legacy key |
| `autorun` | `browserLaunch.enabled` | (value) => value |
| `autorunHostname` | `browserLaunch.hostname` | (value) => value |
| `autorunPortOverride` | `browserLaunch.port` | (value) => value |
| `avoidLocalhost` | `browserLaunch.avoidLocalhost` | (value) => value |
| `extras.promptExpansionModel` | `extras.promptExpansionModel` | remove legacy key |
| `autheliaAuth` | `sso.autheliaAuth` | (value) => value |
| `authentikAuth` | `sso.authentikAuth` | (value) => value |

## Implementation status

- Fresh config bytes and existing-config migration/default insertion: implemented against the pinned Node oracle in `internal/configinit`.
- Runtime read sites: statically detected only for literal `getConfigValue()` calls; dynamic key use needs manual review.
- CLI precedence, global-mode path rules, deprecated aliases, data-root creation, malformed-config continuation, and startup integration: not implemented or not fully probed.

## Recorded boundaries

These keys are ACCEPTED (parsed, preserved, and reported through the migration/default-insertion paths) and are NOT
implemented. Each entry says what is missing, where the pinned behaviour lives, why a pure-Go port is out of scope
or too large for this change, and what a user sees because of it. This section exists because a parser touch that is
never read is the failure AGENTS.md rule 18 forbids, and the honest alternative is a named gap with a reason.

### `performance.memoryCacheCapacity` (and its legacy spelling `cardsCacheCapacity`)

- **Missing:** the bounded in-memory cache of PARSED CHARACTER CARD JSON. Pinned reads the key once at module load
  (`src/endpoints/characters.js:30-31`: `const memoryCacheCapacity = getConfigValue('performance.memoryCacheCapacity',
  '100mb'); const memoryCache = new MemoryLimitedMap(memoryCacheCapacity);`) and `MemoryLimitedMap`
  (`src/util.js:1144-1323`) evicts least-recently-inserted entries whenever `currentMemory + newValueSize` would
  exceed `bytes.parse(capacity)`; `estimateStringSize` is `str.length * 2`; a value whose own size exceeds the
  capacity is refused outright; and `maxMemory <= 0` disables the cache entirely. A legacy `cardsCacheCapacity: N`
  is migrated to `N` + `mb` (`src/config-init.js:91-94`, mirrored by `internal/configinit/config.go:63`).
- **Why no port:** GoTavern does not keep a character-card memory cache at all. Cards are read and parsed per
  request (`internal/server/characters_read.go` -> `processCharacter`), so there is no cache for a capacity to
  bound, and implementing one would be adding a new performance subsystem rather than porting a config key. That
  is a real product decision with a real cost (a large card library re-parses a card on every listing) and it does
  not belong in a parity-key change. **`performance.useDiskCache` is in the same position** and is the other half
  of the same pinned feature: `useDiskCache` writes the parsed JSON to a disk cache, `memoryCacheCapacity` bounds
  the in-memory copy, and neither exists here.
- **What a user sees:** the setting is accepted, preserved in `config.yaml`, and has NO effect. Nothing breaks and
  no response differs - unlike the other boundaries this one has no observable HTTP difference, only a memory and
  latency one (a large library costs more CPU per `/api/characters/all`, and the process's memory use does not
  follow the configured figure). A `0` that pinned treats as "no cache" therefore also changes nothing, which
  means an operator cannot use a divergence here to detect the gap.

### `gemini.enableSystemPromptCache`

- **Missing:** the OpenRouter `cache_control` stamp on the system prompt for a cacheable Gemini model. Pinned reads
  the flag per request (`src/endpoints/backends/chat-completions.js:2370`) and applies it at `:2386-2388`, but only
  inside `if (isCacheableGemini && enableGeminiSystemPromptCache)` where
  `isCacheableGemini = isGemini && await isOpenRouterModelCacheable(request.body.model)` (`:2369`). The transform is
  `cachingSystemPromptForOpenRouter` (`src/prompt-converters.js:1072-1113`): find the FIRST `system` message, do
  nothing if it already carries `cache_control` at message or part level, otherwise stamp the LAST `text` part with
  `{type:'ephemeral'}` - no `ttl`, unlike Claude's `cacheTTL` - and replace a string `content` with a one-element
  block array carrying it.
- **Why no port in this change:** the flag CANNOT be applied without the `isOpenRouterModelCacheable` probe, and
  that probe is itself a recorded gap: it is `await fetch('https://openrouter.ai/api/v1/models')` with a
  5-second abort (`:138-175`), matched against `pricing.input_cache_write != null`, with positive results cached in
  a module-level array. Three consequences, each of which makes "apply the flag only" WRONG rather than partial:
  the probe adds an outbound request to every Gemini-through-OpenRouter call (so a body comparison that ignored the
  request count would pass while the request sequence differed); the probe is a live network capability lookup that
  GoTavern does not currently make anywhere; and without it the only defensible assumption is "cacheable", which
  would emit `cache_control` for models pinned would NOT cache - a different provider body, not a subset. The
  /models probe is deliberately absent from `internal/server/openrouter_chat.go` (see its
  `pinnedOpenRouterGeminiModel` branch, which sends `safety_settings` but makes one fewer request than pinned).
- **What a user sees:** with the flag on and a Gemini model routed through OpenRouter, GoTavern's request carries no
  `cache_control`, so the provider offers no prompt-cache write discount; token accounting and billing differ, while
  the completion itself does not. **The same flag name under `claude` IS implemented** (`claude.enableSystemPromptCache`,
  `internal/server/claude_cache.go`), so a reader must not generalise from that one to Gemini's.
  **Remaining work, in two pieces:** (1) the `isOpenRouterModelCacheable` probe with a seam for the recorded
  differential and a positive-only cache; (2) `cachingSystemPromptForOpenRouter` applied to `request.body.messages`
  before assembly, gated on the probe result AND the flag. Piece 2 without piece 1 must never be shipped.

### `git.backend: builtin` (integrated isomorphic-git backend)

- **Missing:** the integrated git backend. `default/config.yaml:312-317` documents `auto` (prefer system git, fall
  back to the integrated one), `system` and `builtin`; the value is read by `src/endpoints/extensions.js` through
  the git-backend selector, and `builtin` forces the in-process implementation rather than shelling out to `git`.
- **Why out of scope:** "builtin" is not a config switch on one code path, it is a whole git implementation. Pinned
  gets it from `isomorphic-git` (a JavaScript re-implementation of the git object model, the packfile protocol,
  refs, index formats and checkout), and reproducing its semantics faithfully enough that extension install/update
  results stay byte-identical to pinned is a project of its own. The alternative - treat `builtin` as `system` -
  would silently claim the wrong capability and would break on a machine with no `git`, which is exactly the case
  the setting exists for. GoTavern's git path therefore stays the system-git path, and `builtin` must stay a
  visible boundary. **A pure-Go git library would also be a new module dependency** (AGENTS distribution rules),
  which is not something a parity-key change may take on unilaterally.
- **What a user sees:** extension and server-plugin repository operations still work wherever the system `git` is
  on `PATH`. On a machine with no `git`, they fail with a causal error naming the missing executable rather than
  using the integrated backend, and setting `git.backend: builtin` (or `auto` on such a machine) does not change
  that. Selection is not silently ignored in the other direction: no code pretends `builtin` was used.

### `backups.chat.*` (per-chat backups)

- **Missing:** the per-chat chat-file backup subsystem. `default/config.yaml` carries `backups.chat.enabled`,
  `backups.chat.maxTotalBackups` and `backups.chat.throttleInterval` (migrated from `disableChatBackup`,
  `maxTotalChatBackups` and `chatBackupThrottleInterval` at `src/config-init.js`, mirrored by
  `internal/configinit/config.go:50-53`), and `src/endpoints/chats.js` consults them when it writes a chat: it
  decides whether a pre-write snapshot is taken, prunes the snapshot directory by total size, and throttles how
  often a snapshot is taken for the same chat.
- **Why out of scope:** this is a storage subsystem with its own retention/pruning rules, its own failure handling
  and its own on-disk layout under the user's data directory, not a switch on an existing writer. Porting it
  requires reproducing the exact naming, the exact prune order and the exact throttle bookkeeping before it can be
  claimed, and a partial port (write snapshots, no pruning) would fill a user's disk - worse than the gap. Only
  `backups.common.numberOfBackups` and `backups.allowFullDataBackup` participate in the implemented settings-backup
  path, and they are reported as such; the per-chat family is not.
- **What a user sees:** chat writes and chat persistence are unaffected, and nothing is ever pruned by a
  half-implemented backup path. What is absent is the safety net: after a bad edit or an accidental overwrite
  there is no per-chat snapshot to restore, and the chat-backup directory a pinned install would have populated
  stays absent. The settings UI still shows the toggles, because it is the pinned frontend.

### VertexAI service-account mode

- **Missing:** Vertex AI's service-account credential path (the JSON key file, its JWT-bearer OAuth flow, token
  caching and the project/region endpoint construction). Pinned's Google backend accepts either an API key or a
  service-account JSON and, in the latter case, obtains an OAuth access token before calling the regional
  `*-aiplatform.googleapis.com` endpoint.
- **Why out of scope:** it is an OAuth client-credentials implementation with its own token lifecycle and a
  different endpoint scheme, and it cannot be verified without either a real service account or a recorded
  credential exchange. Faking the exchange would produce a fixture for a behaviour that never ran. It is a
  self-contained feature request, not a config-key read.
- **What a user sees:** API-key use of the Google/Gemini sources works. A user who configures a Vertex AI
  service-account JSON is not silently routed: the request fails with an error naming the unsupported credential
  mode instead of sending a malformed provider request to a regional endpoint.

### Provider embedding sources

- **Missing:** the provider-hosted embedding sources inside `/api/vector/*` (OpenAI/Google/Cohere/Mistral etc.).
  Those routes call out to a provider's embeddings endpoint through the same additional-headers machinery the
  implemented chat paths use.
- **Why out of scope here:** the local in-process sources are already recorded as an architectural exclusion
  (AGENTS.md boundary list, local ML inference: `getPipeline()` in `src/transformers.js` runs an ONNX model inside
  the server, and serving that would mean adopting an ONNX runtime, which contradicts `CGO_ENABLED=0`). The
  provider-hosted sources are a separate and larger piece - each has its own request shape, batching, dimension
  handling and error mapping - and none of it is a config key; it is route work that must land with its own
  provider-wire evidence, not as a side effect of a config-parity change.
- **What a user sees:** vector storage/search that depends on a provider-hosted embedding is not available, and the
  routes report it as unimplemented rather than returning an empty embedding set, which would corrupt a user's
  vector index silently. This boundary is NOT claimed as covered by the local-inference exclusion; they are two
  different gaps that share a route prefix.
