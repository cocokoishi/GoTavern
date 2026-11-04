package server

import "net/http"

// domainRouteRegistrar registers the HTTP routes owned by one API domain.
//
// A registrar must register only patterns its own domain owns and must not
// depend on any other registrar having run: the table below is ordered for
// review, not for correctness, because ServeMux selects the most specific
// pattern regardless of registration order. Registering a pattern twice panics
// at construction time (routes_registry_test.go proves the teeth of that), so a
// mistaken owner is refused immediately instead of silently shadowing a route.
type domainRouteRegistrar func(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions)

// routeDomain is one row of the route-domain inventory: the domain's name (the
// value a reader and a test refer to) and the function that registers it.
type routeDomain struct {
	name     string
	register domainRouteRegistrar
}

// routeDomainTable returns the explicit, ordered inventory of route domains.
//
// THE CONTRACT: this table is the route-domain inventory. A domain that is not
// listed here is not registered, however many files in this package mention it.
// Adding a route file means adding a row; removing a domain means deleting its
// row. The order is alphabetical by name and is NOT observable (ServeMux picks
// the most specific pattern; duplicates panic), so it exists only to keep the
// register readable and deterministic.
//
// Before M4a each domain appended itself to a package-level slice from an
// init() function, which made route registration a package side effect: there
// was no single place listing the domains, a test could not select a subset,
// and adding a file silently added routes. The table replaces that mechanism
// and routes_registry_test.go pins both the names and the registrar functions.
func routeDomainTable() []routeDomain {
	// The chat-completion source registry validates its rows (every source has
	// a name and all three behaviours) and panics on a malformed one. It used
	// to do this from its own init(); it is the one registration-adjacent job
	// that was more than an append, so it is kept but moved here, to the moment
	// the table is constructed. Construction happens before any handler is
	// built, which is the ordering the validation needs, and routeDomainTable
	// is idempotent so calling it more than once is safe.
	validateChatCompletionSourceRegistry()

	return []routeDomain{
		{name: "anthropic-caption", register: registerAnthropicCaptionRoutes},
		{name: "assets", register: registerAssetsRoutes},
		{name: "azure-tts", register: registerAzureTTSRoutes},
		{name: "backends", register: registerBackendsRoutes},
		{name: "backends-kobold-deferred", register: registerBackendsKoboldDeferredRoutes},
		{name: "backends-textgen-generate", register: registerBackendsTextgenGenerateRoutes},
		{name: "backups", register: registerBackupsRoutes},
		{name: "backups-chat-get", register: registerBackupsChatGetRoutes},
		{name: "characters", register: registerCharactersRoutes},
		{name: "chat-completions", register: registerChatCompletionRoutes},
		{name: "chats", register: registerChatRoutes},
		{name: "chats-groups", register: registerChatAndGroupRoutes},
		{name: "content", register: registerContentRoutes},
		{name: "data-maid", register: registerDataMaidRoutes},
		{name: "extensions", register: registerExtensionsRoutes},
		{name: "extensions-static", register: registerExtensionStaticRoutes},
		{name: "frontend-assets", register: registerFrontendAssetRoutes},
		{name: "google-media", register: registerGoogleMediaRoutes},
		{name: "google-native-tts", register: registerGoogleNativeTTSRoutes},
		{name: "google-video", register: registerGoogleVideoRoutes},
		{name: "google-voice", register: registerGoogleVoiceRoutes},
		{name: "horde", register: registerHordeRoutes},
		{name: "horde-generation", register: registerHordeGenerationRoutes},
		{name: "images", register: registerImageRoutes},
		{name: "minimax", register: registerMiniMaxRoutes},
		{name: "nanogpt", register: registerNanoGPTRoutes},
		{name: "novelai", register: registerNovelAIRoutes},
		{name: "novelai-generate", register: registerNovelAIGenerateRoutes},
		{name: "openai-caption", register: registerOpenAICaptionRoutes},
		{name: "openai-chutes-transcribe", register: registerOpenAIChutesTranscribeRoutes},
		{name: "openai-generate-video", register: registerOpenAIVideoRoutes},
		{name: "openai-media", register: registerOpenAIMediaRoutes},
		{name: "openai-models", register: registerOpenAIModelRoutes},
		{name: "openai-transcribe", register: registerOpenAITranscribeRoutes},
		{name: "openrouter", register: registerOpenRouterRoutes},
		{name: "presets", register: registerPresetRoutes},
		{name: "redirect-aliases", register: registerDeprecatedRedirectAliases},
		{name: "sd", register: registerSDRoutes},
		{name: "sd-generate", register: registerSDGenerateRoutes},
		{name: "sd-generate-comfy", register: registerSDComfyGenerateRoutes},
		{name: "sd-generate-wave2", register: registerSDGenerateWave2Routes},
		{name: "sd-generate-wave5", register: registerSDGenerateWave5Routes},
		{name: "sd-zai", register: registerSDZaiRoutes},
		{name: "search", register: registerSearchRoutes},
		{name: "secrets", register: registerSecretsRoutes},
		{name: "speech", register: registerSpeechRoutes},
		{name: "sprites-upload", register: registerSpritesUploadRoutes},
		{name: "stats", register: registerStatsRoutes},
		{name: "thumbnails", register: registerThumbnailRoutes},
		{name: "tokenizers", register: registerTokenizerRoutes},
		{name: "translate", register: registerTranslateRoutes},
		{name: "vector", register: registerVectorRoutes},
		{name: "volcengine", register: registerVolcengineRoutes},
		{name: "worldinfo", register: registerWorldInfoRoutes},
	}
}

// registerDomainRoutes runs every domain registrar in the table. The table is a
// parameter rather than a package-level variable so a caller (and a test) states
// which inventory it builds from; newHTTPHandlerWithRouteDomains passes
// routeDomainTable(), and the empty inventory builds a handler with only the
// hand-written base routes.
func registerDomainRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions, domains []routeDomain) {
	for _, domain := range domains {
		domain.register(mux, accounts, notFoundPage, options)
	}
}
