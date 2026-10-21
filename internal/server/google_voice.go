package server

// Pinned /api/google voice routes, wave 1: `list-voices` only.
//
//	POST /api/google/list-voices    google.js:291
//
// The pinned handler is `response.json(languages)` where `languages` is the `google-translate-api-x`
// package table (version 10.7.2, `lib/languages.cjs`). It performs NO request, so there is no outbound
// surface to compare and no seam: the observable is the response bytes alone, including the table ORDER
// and the duplicate-key resolution, which the oracle records and this hand-written table reproduces.
// `google_languages.go` is generated from the pinned package and verified against the recorded route.
//
// `POST /api/google/generate-voice` (google.js:295) stays `not implemented` by decision, not by
// oversight. The handler delegates to `speak()` in the same package, which builds a private Google
// `batchexecute` request (rpcids=jQ1olc, a `f.req` form body, and a non-JSON response parsed by slicing
// six characters and scanning `wrb.fr` rows). It IS pinnable — the package calls the global `fetch`, so
// a controlled peer captures the URL, the form body and the response — but the protocol belongs to the
// dependency, not to the pinned server, so porting it would make GoTavern own a copy of an undocumented
// private Google endpoint and track that package forever, for one route. AGENTS.md records the rule
// ("a behaviour implemented inside a dependency is not ported unless a user requirement forces it") and
// the decision is reversible: a user requirement turns it into an explicit product decision with a
// stated cost. `tools/probe-google-voices.mjs` records the same reasoning in the fixture.
//
// The rest of the domain (`caption-image`, `generate-image`, `generate-video`, `list-native-voices`,
// `generate-native-tts`) is NOT normalised here: `generate-native-tts` in particular is a different
// envelope (API-key or OAuth service-account JWT, then PCM wrapped into WAV by `createCompleteWavFile`),
// and `list-native-voices` is a hardcoded table that this increment does not cover.

import (
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerGoogleVoiceRoutes)
}

func registerGoogleVoiceRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/google/list-voices", accounts.serveGoogleListVoices)
}

// serveGoogleListVoices answers the pinned language/voice table. The route performs no request and reads
// no secret: the pinned handler ignores the request entirely.
func (runtime *accountRuntime) serveGoogleListVoices(w http.ResponseWriter, request *http.Request) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	table := nodeObject()
	for _, entry := range googleLanguages {
		table.setMember(entry.code, nodeString(entry.name))
	}
	body, err := marshalCharacterJSON(table)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// googleGetCode reproduces the pinned package `getCode(desiredLang)` from lib/languages.cjs, which is
// what `generate-voice` would need if that route were ever promoted. It is kept here because it is the
// only other pinned behaviour the table encodes, and it is tested as a derivation from the pinned
// package (no oracle can exist for a route that is not implemented).
//
//   - a non-string returns null;
//   - an own key wins, and that is a plain object lookup, so an inherited Object.prototype property
//     (`toString`, `constructor`) also "matches" and is returned as the code;
//   - otherwise the first key whose NAME matches case-insensitively wins, and a code is never matched
//     case-insensitively;
//   - no match returns null.
func googleGetCode(desiredLang any) (string, bool) {
	text, isString := desiredLang.(string)
	if !isString {
		return "", false
	}
	for _, entry := range googleLanguages {
		if entry.code == text {
			return text, true
		}
	}
	for _, inherited := range googleObjectPrototypeKeys {
		if inherited == text {
			return text, true
		}
	}
	lowered := lowerTrim(text)
	for _, entry := range googleLanguages {
		if lowerTrim(entry.name) == lowered {
			return entry.code, true
		}
	}
	return "", false
}

// googleObjectPrototypeKeys are the own properties of Object.prototype that the pinned `langs[key]`
// lookup would resolve through the prototype chain.
var googleObjectPrototypeKeys = []string{
	"constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty",
	"isPrototypeOf", "propertyIsEnumerable", "__defineGetter__", "__defineSetter__",
	"__lookupGetter__", "__lookupSetter__", "__proto__",
}

// googleSecretUnused keeps the startup import meaningful if this file ever gains an outbound route; the
// list route reads no secret, and that is a pinned property rather than an oversight.
var _ = startup.UserDirectories{}
