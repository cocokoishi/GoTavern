package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// THE ROUTE-DOMAIN INVENTORY IS EXPLICIT, AND THIS TEST IS ITS GOLDEN LIST.
//
// Before M4a every domain registered itself from an init() function that
// appended its registrar to a package-level slice, so "which domains do we
// serve" was a package side effect. That is exactly the kind of fact a
// refactor can silently change: drop one registrar and the only symptom is a
// 404 that no unit test names. This test pins the effective inventory (the
// registrar functions, not just a count) so a domain cannot leave the server
// by accident, and the representative-route test below proves that every
// pinned domain still registers at least one route.
const expectedRouteDomainCount = 54

// expectedRouteRegistrars is the sorted set of registrar functions that were
// effectively registered when M4a started (measured from the 54 init() appends).
// It is a golden list on purpose: adding a domain means adding a row to the
// explicit table AND updating this list, which is a visible, reviewable edit.
var expectedRouteRegistrars = []string{
	"registerAnthropicCaptionRoutes",
	"registerAssetsRoutes",
	"registerAzureTTSRoutes",
	"registerBackendsKoboldDeferredRoutes",
	"registerBackendsRoutes",
	"registerBackendsTextgenGenerateRoutes",
	"registerBackupsChatGetRoutes",
	"registerBackupsRoutes",
	"registerCharactersRoutes",
	"registerChatAndGroupRoutes",
	"registerChatCompletionRoutes",
	"registerChatRoutes",
	"registerContentRoutes",
	"registerDataMaidRoutes",
	"registerDeprecatedRedirectAliases",
	"registerExtensionStaticRoutes",
	"registerExtensionsRoutes",
	"registerFrontendAssetRoutes",
	"registerGoogleMediaRoutes",
	"registerGoogleNativeTTSRoutes",
	"registerGoogleVideoRoutes",
	"registerGoogleVoiceRoutes",
	"registerHordeGenerationRoutes",
	"registerHordeRoutes",
	"registerImageRoutes",
	"registerMiniMaxRoutes",
	"registerNanoGPTRoutes",
	"registerNovelAIGenerateRoutes",
	"registerNovelAIRoutes",
	"registerOpenAICaptionRoutes",
	"registerOpenAIChutesTranscribeRoutes",
	"registerOpenAIMediaRoutes",
	"registerOpenAIModelRoutes",
	"registerOpenAITranscribeRoutes",
	"registerOpenAIVideoRoutes",
	"registerOpenRouterRoutes",
	"registerPresetRoutes",
	"registerSDComfyGenerateRoutes",
	"registerSDGenerateRoutes",
	"registerSDGenerateWave2Routes",
	"registerSDGenerateWave5Routes",
	"registerSDRoutes",
	"registerSDZaiRoutes",
	"registerSearchRoutes",
	"registerSecretsRoutes",
	"registerSpeechRoutes",
	"registerSpritesUploadRoutes",
	"registerStatsRoutes",
	"registerThumbnailRoutes",
	"registerTokenizerRoutes",
	"registerTranslateRoutes",
	"registerVectorRoutes",
	"registerVolcengineRoutes",
	"registerWorldInfoRoutes",
}

// routeDomainProbe is one request that must reach a route owned by the named
// domain. A probe is deliberately a *request* rather than a pattern string:
// the assertion is that the registered pattern matches the request, which is
// what a caller observes, and it therefore also catches a registrar that
// registers nothing because of a bad loop or condition.
type routeDomainProbe struct {
	method string
	path   string
}

// routeDomainProbes maps every registrar in expectedRouteRegistrars to one
// representative request. Keeping the map keyed by registrar (not by a
// human-readable domain label) keeps it identical before and after the table
// refactor; a registrar that gains no probe fails the coverage assertion.
var routeDomainProbes = map[string]routeDomainProbe{
	"registerAnthropicCaptionRoutes":        {http.MethodPost, "/api/anthropic/caption-image"},
	"registerAssetsRoutes":                  {http.MethodPost, "/api/assets/get"},
	"registerAzureTTSRoutes":                {http.MethodPost, "/api/azure/list"},
	"registerBackendsRoutes":                {http.MethodPost, "/api/backends/chat-completions/bias"},
	"registerBackendsKoboldDeferredRoutes":  {http.MethodPost, "/api/backends/kobold/generate"},
	"registerBackendsTextgenGenerateRoutes": {http.MethodPost, "/api/backends/text-completions/generate"},
	"registerBackupsRoutes":                 {http.MethodPost, "/api/backups/chat/delete"},
	"registerBackupsChatGetRoutes":          {http.MethodPost, "/api/backups/chat/get"},
	"registerCharactersRoutes":              {http.MethodPost, "/api/characters/all"},
	"registerChatAndGroupRoutes":            {http.MethodPost, "/api/chats/rename"},
	"registerChatCompletionRoutes":          {http.MethodPost, "/api/backends/chat-completions/generate"},
	"registerChatRoutes":                    {http.MethodPost, "/api/chats/save"},
	"registerContentRoutes":                 {http.MethodPost, "/api/content/importURL"},
	"registerDataMaidRoutes":                {http.MethodPost, "/api/data-maid/report"},
	"registerDeprecatedRedirectAliases":     {http.MethodGet, "/createcharacter"},
	"registerExtensionStaticRoutes":         {http.MethodGet, "/scripts/extensions/third-party/probe.js"},
	"registerExtensionsRoutes":              {http.MethodPost, "/api/extensions/install"},
	"registerFrontendAssetRoutes":           {http.MethodGet, "/css/user.css"},
	"registerGoogleMediaRoutes":             {http.MethodPost, "/api/google/caption-image"},
	"registerGoogleNativeTTSRoutes":         {http.MethodPost, "/api/google/generate-native-tts"},
	"registerGoogleVideoRoutes":             {http.MethodPost, "/api/google/generate-video"},
	"registerGoogleVoiceRoutes":             {http.MethodPost, "/api/google/list-voices"},
	"registerHordeGenerationRoutes":         {http.MethodPost, "/api/horde/cancel-task"},
	"registerHordeRoutes":                   {http.MethodPost, "/api/horde/status"},
	"registerImageRoutes":                   {http.MethodPost, "/api/images/upload"},
	"registerMiniMaxRoutes":                 {http.MethodPost, "/api/minimax/generate-voice"},
	"registerNanoGPTRoutes":                 {http.MethodPost, "/api/nanogpt/credits"},
	"registerNovelAIGenerateRoutes":         {http.MethodPost, "/api/novelai/generate"},
	"registerNovelAIRoutes":                 {http.MethodPost, "/api/novelai/status"},
	"registerOpenAICaptionRoutes":           {http.MethodPost, "/api/openai/caption-image"},
	"registerOpenAIChutesTranscribeRoutes":  {http.MethodPost, "/api/openai/chutes/transcribe-audio"},
	"registerOpenAIMediaRoutes":             {http.MethodPost, "/api/openai/generate-voice"},
	"registerOpenAIModelRoutes":             {http.MethodPost, "/api/openai/electronhub/models"},
	"registerOpenAITranscribeRoutes":        {http.MethodPost, "/api/openai/transcribe-audio"},
	"registerOpenAIVideoRoutes":             {http.MethodPost, "/api/openai/generate-video"},
	"registerOpenRouterRoutes":              {http.MethodPost, "/api/openrouter/models/providers"},
	"registerPresetRoutes":                  {http.MethodPost, "/api/presets/save"},
	"registerSDComfyGenerateRoutes":         {http.MethodPost, "/api/sd/comfy/generate"},
	"registerSDGenerateRoutes":              {http.MethodPost, "/api/sd/pollinations/generate"},
	"registerSDGenerateWave2Routes":         {http.MethodPost, "/api/sd/huggingface/generate"},
	"registerSDGenerateWave5Routes":         {http.MethodPost, "/api/sd/bfl/generate"},
	"registerSDZaiRoutes":                   {http.MethodPost, "/api/sd/zai/generate"},
	"registerSDRoutes":                      {http.MethodPost, "/api/sd/ping"},
	"registerSearchRoutes":                  {http.MethodPost, "/api/search/serpapi"},
	"registerSecretsRoutes":                 {http.MethodPost, "/api/secrets/write"},
	"registerSpeechRoutes":                  {http.MethodPost, "/api/speech/pollinations/voices"},
	"registerSpritesUploadRoutes":           {http.MethodPost, "/api/sprites/upload"},
	"registerStatsRoutes":                   {http.MethodPost, "/api/stats/get"},
	"registerThumbnailRoutes":               {http.MethodGet, "/thumbnail"},
	"registerTokenizerRoutes":               {http.MethodPost, "/api/tokenizers/gpt2/encode"},
	"registerTranslateRoutes":               {http.MethodPost, "/api/translate/libre"},
	"registerVectorRoutes":                  {http.MethodPost, "/api/vector/query"},
	"registerVolcengineRoutes":              {http.MethodPost, "/api/volcengine/generate-voice"},
	"registerWorldInfoRoutes":               {http.MethodPost, "/api/worldinfo/list"},
}

// registrarShortName is the last dot-separated component of a registrar's
// runtime name, e.g. "registerStatsRoutes". The package path is omitted so the
// golden list stays readable and does not encode the checkout location.
func registrarShortName(register domainRouteRegistrar) string {
	name := runtime.FuncForPC(reflect.ValueOf(register).Pointer()).Name()
	if dot := strings.LastIndexByte(name, '.'); dot >= 0 {
		return name[dot+1:]
	}
	return name
}

// effectiveRouteRegistrars returns the registrars the package actually
// registers. Before M4a this is the init()-populated slice; after M4a it is
// the explicit table. Keeping this accessor in the test is what lets the same
// golden list prove both halves of the refactor.
func effectiveRouteRegistrars() []domainRouteRegistrar {
	return domainRouteRegistrars
}

func TestRouteDomainInventoryIsThePinnedSet(t *testing.T) {
	registrars := effectiveRouteRegistrars()
	if len(registrars) != expectedRouteDomainCount {
		t.Fatalf("route-domain inventory has %d registrars; pinned count is %d", len(registrars), expectedRouteDomainCount)
	}
	got := make([]string, 0, len(registrars))
	seen := make(map[string]bool, len(registrars))
	for index, register := range registrars {
		if register == nil {
			t.Fatalf("route-domain inventory entry %d is nil", index)
		}
		name := registrarShortName(register)
		if seen[name] {
			t.Fatalf("route-domain registrar %s appears twice in the inventory", name)
		}
		seen[name] = true
		got = append(got, name)
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, expectedRouteRegistrars) {
		t.Fatalf("route-domain inventory drifted from the pinned set\n got: %v\nwant: %v", got, expectedRouteRegistrars)
	}
}

// TestRouteDomainInventoryHasAProbeForEveryDomain is a coverage assertion on
// the test itself: a domain added to the table without a representative route
// would otherwise be invisible to the registration half of this file.
func TestRouteDomainInventoryHasAProbeForEveryDomain(t *testing.T) {
	registered := make(map[string]bool)
	for _, register := range effectiveRouteRegistrars() {
		registered[registrarShortName(register)] = true
	}
	for name := range routeDomainProbes {
		if !registered[name] {
			t.Errorf("probe exists for %s but no such registrar is registered", name)
		}
	}
	for name := range registered {
		if _, ok := routeDomainProbes[name]; !ok {
			t.Errorf("registrar %s has no representative route probe", name)
		}
	}
}

// TestRouteDomainsRegisterRepresentativeRoutes registers the whole inventory on
// a fresh ServeMux (which itself refuses duplicate patterns by panicking) and
// asserts one request per domain matches a non-empty pattern. A registrar that
// silently registers nothing, or registers under a path it did not before,
// fails here with the domain named.
func TestRouteDomainsRegisterRepresentativeRoutes(t *testing.T) {
	accounts := newAccountRuntime(HTTPHandlerOptions{})
	mux := http.NewServeMux()
	registerDomainRoutes(mux, accounts, nil, HTTPHandlerOptions{})
	for name, probe := range routeDomainProbes {
		request := httptest.NewRequest(probe.method, probe.path, nil)
		_, pattern := mux.Handler(request)
		if pattern == "" {
			t.Errorf("%s: %s %s matches no registered pattern", name, probe.method, probe.path)
		}
	}
}

// TestRouteDomainDuplicateRegistrationPanics is the teeth for the uniqueness
// claim: ServeMux panics on a duplicate pattern, and this test shows that a
// duplicated registrar reaches that panic rather than being swallowed by the
// registry. If this test ever stops panicking, the inventory can silently
// shadow a route and the explicit table is no longer a single owner.
func TestRouteDomainDuplicateRegistrationPanics(t *testing.T) {
	inventory := append([]domainRouteRegistrar{}, effectiveRouteRegistrars()...)
	inventory = append(inventory, registerStatsRoutes)
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("registering the same domain twice did not panic; duplicate patterns would be accepted")
		}
		// ServeMux's own wording is part of the observation: if this panics for
		// an unrelated reason, the test must say so rather than pass through.
		// Go changed the duplicate-pattern wording across releases, so both the
		// old and current spellings are accepted; the duplicated PATTERN is the
		// stable part of the observation.
		message := fmt.Sprint(recovered)
		if !strings.Contains(message, "/api/stats/get") ||
			!(strings.Contains(message, "conflicts with pattern") || strings.Contains(message, "multiple registrations")) {
			t.Fatalf("duplicate registration panicked for an unexpected reason: %v", recovered)
		}
	}()
	mux := http.NewServeMux()
	accounts := newAccountRuntime(HTTPHandlerOptions{})
	for _, register := range inventory {
		register(mux, accounts, nil, HTTPHandlerOptions{})
	}
}
