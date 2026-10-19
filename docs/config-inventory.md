# Pinned configuration inventory

Baseline: SillyTavern 1.19.0 at `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Defaults are read from `default/config.yaml`; CLI options and key migrations are read from `src/command-line.js` and `src/config-init.js`.

Default leaf keys inventoried: **116**. CLI options inventoried: **31**.

Pinned `getConfigValue(key, default, type)` first reads `SILLYTAVERN_` plus the uppercased key with dots changed to underscores, then falls back to YAML. A present environment variable takes precedence over YAML. Type conversion is call-site-specific. The CLI parser applies explicit command-line values before config lookups for fields listed below.

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

Migrations run in `addMissingConfigValues()` before missing defaults are added. The same old-to-new environment-variable names are redirected when the old environment variable is present and the new one is absent. YAML parsing/stringification and error handling remain to be implemented and probed.

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

- Default key list and values: inventoried from pinned YAML.
- Runtime read sites: statically detected only for literal `getConfigValue()` calls; dynamic key use needs manual review.
- CLI precedence, global-mode path rules, deprecated aliases, data-root creation, config migration, write formatting, and error side effects: not implemented.
