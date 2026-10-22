package server

// Pinned `POST /api/anthropic/caption-image` (src/endpoints/anthropic.js:8-66 -- the whole file).
//
// The route is twenty lines of work and nearly every line is a branch, so the implementation follows the
// pinned TEXT rather than a cleaned-up version of it. The oracle is
// tests/oracle/sillytavern-1.19.0-anthropic-caption.json, recorded by tools/probe-anthropic-caption.mjs;
// each comment below names the pinned line it reproduces and the scenario that pins it.
//
// THE BRANCHES A CLEANUP WOULD COLLAPSE, each measured rather than argued:
//
//   - `request.body.image.split(';')[0].split(':')[1]` and `request.body.image.split(',')[1]` are
//     UNGUARDED. `scenarios.image.noComma` / `image.noColon` show the consequence: the missing half is
//     `undefined`, and `JSON.stringify` OMITS an undefined member, so the outbound `source` object carries
//     `media_type` without `data` (or the reverse). Writing the string "undefined" into the body, or
//     sending an empty member, is a different request on the wire.
//   - `request.body.image` ABSENT or not a string throws inside the `try` (`.split` is not a function), so
//     the catch answers 500 `Internal server error` with ZERO outbound requests
//     (`scenarios.image.absent`).
//   - `generateResponseJson.content[0].text` is read with NO guard. An absent `content`, an empty array, a
//     body that is not JSON, and a body that is a JSON array all THROW, and the catch answers 500
//     `Internal server error` (`ok.contentAbsent`, `ok.contentEmptyArray`, `ok.notJson`, `ok.arrayBody`).
//     That is a DIFFERENT branch from `if (!caption)` -> `No caption found` (`ok.textEmptyString`,
//     `ok.textZero`, `ok.textFalse`, `ok.textNull`), and an implementation that returned
//     `No caption found` for a parse failure would pass a status-only check while taking the wrong branch.
//   - `if (!caption)` is JavaScript FALSINESS, not emptiness: `''`, `0`, `false` and `null` all answer
//     `No caption found`.
//   - a non-2xx upstream is flattened to the upstream STATUS with `{error: true}` and the provider body is
//     DISCARDED, for a JSON body and a text body alike (`upstream.jsonError`, `upstream.textError`).
//   - the URL is a TEMPLATE LITERAL: `${baseUrl}/messages`, with no url join. A `reverse_proxy` ending in
//     `/` therefore produces a DOUBLE SLASH in the path (`proxy.trailingSlash` records `/v1//messages`),
//     because the pinned code does not normalise either.
//   - the key is `request.body.reverse_proxy ? request.body.proxy_password : readSecret(..CLAUDE)`. With
//     `reverse_proxy` set and `proxy_password` ABSENT the pinned code passes `undefined` as the header
//     value, and node-fetch puts the LITERAL string "undefined" on the wire -- recorded from a real
//     listener (`wire.noProxyPassword`) rather than inferred, because the stub records the route's raw
//     object and not the wire.
//   - the stored secret is read even when it is absent, and an absent secret sends an EMPTY `x-api-key`
//     rather than dropping the header (`secret.absent`).
//   - a transport failure is a THROW, not a non-ok response: the catch answers `Internal server error`,
//     while a non-ok RESPONSE answers `{error: true}`. Both are recorded, and `transport.closedPort` is a
//     REAL refused connection on an unhooked pinned boot.
//
// STATED GAPS, not claimed behaviour: the route sets no timeout, so a peer that accepts the connection and
// never answers is not probed; the pinned `console.debug`/`console.warn` output is not an HTTP observable.
// A malformed JSON body never reaches the handler at all (express.json answers 400 with Node's development
// error page), so this route answers the pinned STATUS and claims nothing about that page's bytes.

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	// anthropicCaptionDefaultBaseURL is the pinned literal in the ternary at anthropic.js:12.
	anthropicCaptionDefaultBaseURL = "https://api.anthropic.com/v1"
	// anthropicCaptionSecretKey is SECRET_KEYS.CLAUDE (src/endpoints/secrets.js:18).
	anthropicCaptionSecretKey = "api_key_claude"
	// anthropicCaptionVersion is the pinned constant header at anthropic.js:41.
	anthropicCaptionVersion = "2023-06-01"
	// anthropicCaptionMaxTokens is the pinned literal at anthropic.js:31.
	anthropicCaptionMaxTokens = 4096
	// anthropicCaptionUndefinedHeader is what node-fetch puts on the wire for an `undefined` header value.
	// It is MEASURED (scenarios.wire.noProxyPassword, recorded from a real listener), not derived from the
	// JavaScript language: the pinned handler passes `undefined` and node-fetch stringifies it.
	anthropicCaptionUndefinedHeader = "undefined"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerAnthropicCaptionRoutes)
}

func registerAnthropicCaptionRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/anthropic/caption-image", func(w http.ResponseWriter, r *http.Request) {
		// The pinned router only mounts POST here; anything else falls through to the static 404.
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveAnthropicCaptionImage(w, r, options)
	})
}

// anthropicCaptionSeamEnv is the ONE environment name that redirects this route, used by the request path
// below and asserted against the fixture's `seamDefaults` by the test. The handler builds its URL from the
// pinned LITERAL (or from `reverse_proxy`) and then rewrites that finished target's scheme and host, so the
// PATH the route's concatenation produced survives; starting from the seam value and rewriting again would
// drop the literal's `/v1` segment, which is exactly the bug a double application produced the first time
// this route was replayed.
const anthropicCaptionSeamEnv = "GOTAVERN_ANTHROPIC_CAPTION_BASE_URL"

// anthropicCaptionTextFailure writes the pinned `res.status(500).send('...')`, which Express types as html.
func anthropicCaptionTextFailure(w http.ResponseWriter, message string) {
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", message)
}

// anthropicCaptionJSONError writes the pinned `res.status(status).send({ error: true })`: the upstream
// STATUS is forwarded and the body is always this object, whatever the provider answered.
func anthropicCaptionJSONError(w http.ResponseWriter, status int) {
	answer := nodeObject()
	answer.setMember("error", nodeBool(true))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, status, encoded)
}

// anthropicCaptionJSString is JavaScript `String(value)` for a present member, used for the header value.
// A JSON `null` becomes the text "null" and an absent member is handled by the caller, which mirrors the
// pinned `request.body.proxy_password` being `undefined` rather than absent.
func anthropicCaptionJSString(raw json.RawMessage) (string, bool) {
	decoded, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		return "", false
	}
	return javascriptStringOf(decoded), true
}

func (runtime *accountRuntime) serveAnthropicCaptionImage(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		// The pinned handler never sees an unparsable body: express.json() answers 400 first, so this is
		// the server's answer and not the route's. The scenario records that status; the pinned page's
		// bytes are Node's development error renderer and are classified shape, not compared.
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	// anthropic.js:10 -- `request.body.image.split(';')[0].split(':')[1]`.
	image, isString := googleRawMemberString(input, "image")
	if !isString {
		// `.split` on an absent or non-string member throws inside the pinned `try`.
		anthropicCaptionTextFailure(w, "Internal server error")
		return
	}
	// JS `split(sep)[1]` is the SECOND ELEMENT of a full split, and it is `undefined` when the separator
	// does not occur -- which JSON.stringify then omits. strings.Split reproduces both halves of that.
	mimeType, hasMimeType := "", false
	head := strings.Split(image, ";")[0]
	if colonParts := strings.Split(head, ":"); len(colonParts) > 1 {
		mimeType, hasMimeType = colonParts[1], true
	}
	base64Data, hasBase64Data := "", false
	if commaParts := strings.Split(image, ","); len(commaParts) > 1 {
		base64Data, hasBase64Data = commaParts[1], true
	}

	// anthropic.js:12 -- `request.body.reverse_proxy ? request.body.reverse_proxy : <default>`, which is
	// TRUTHINESS: an empty string or a non-string takes the default. The PINNED LITERAL is the base here;
	// the seam is applied to the finished target below, so this expression stays the pinned one.
	baseURL := anthropicCaptionDefaultBaseURL
	reverseProxy, hasReverseProxy := googleRawMemberString(input, "reverse_proxy")
	proxyKey := anthropicCaptionUndefinedHeader
	if hasReverseProxy && reverseProxy != "" {
		baseURL = reverseProxy
		// anthropic.js:42 -- the proxy password REPLACES the stored key entirely. When the member is absent
		// the pinned value is `undefined`, and the fixture records what a real peer received for it.
		if raw, present := input["proxy_password"]; present && len(raw) > 0 {
			if value, ok := anthropicCaptionJSString(raw); ok {
				proxyKey = value
			}
		}
	} else {
		secret, err := startup.ReadSecretString(directories, anthropicCaptionSecretKey)
		if err != nil {
			anthropicCaptionTextFailure(w, "Internal server error")
			return
		}
		proxyKey = secret
	}

	// anthropic.js:13 -- a TEMPLATE LITERAL, so a base that already ends in "/" keeps its slash.
	target := baseURL + "/messages"

	// TEST SEAM. The default base is a pinned LITERAL, so the only way to replay the recorded request
	// against a controlled peer is to keep the PATH the route built and point its scheme and host at an
	// override. Production leaves it unset and the default is empty, so the literal above is what ships.
	// A `reverse_proxy` supplied in the REQUEST is rewritten the same way, which is why the recorded
	// scenario can compare the path without comparing a port.
	if override := sdSeamURL(anthropicCaptionSeamEnv, ""); override != "" {
		if parsed, err := url.Parse(target); err == nil {
			if base, baseErr := url.Parse(override); baseErr == nil {
				parsed.Scheme = base.Scheme
				parsed.Host = base.Host
				target = parsed.String()
			}
		}
	}

	// anthropic.js:14-32. Member ORDER is contract (hard rule 8): model, messages, max_tokens; inside the
	// message, an image part then a text part; inside `source`, type, media_type, data -- with the two
	// undefined-derived members OMITTED rather than emptied.
	source := nodeObject()
	source.setMember("type", nodeString("base64"))
	if hasMimeType {
		source.setMember("media_type", nodeString(mimeType))
	}
	if hasBase64Data {
		source.setMember("data", nodeString(base64Data))
	}
	imagePart := nodeObject()
	imagePart.setMember("type", nodeString("image"))
	imagePart.setMember("source", source)
	textPart := nodeObject()
	textPart.setMember("type", nodeString("text"))
	// `text: request.body.prompt` -- any JSON value is forwarded as-is, and an ABSENT prompt is omitted.
	setRawMember(&textPart, "text", input["prompt"])
	content := nodeArray()
	content.array = append(content.array, imagePart, textPart)
	message := nodeObject()
	message.setMember("role", nodeString("user"))
	message.setMember("content", content)
	messages := nodeArray()
	messages.array = append(messages.array, message)
	body := nodeObject()
	setRawMember(&body, "model", input["model"])
	body.setMember("messages", messages)
	body.setMember("max_tokens", nodeNumber(anthropicCaptionMaxTokens))
	encoded, err := marshalCharacterJSON(body)
	if err != nil {
		anthropicCaptionTextFailure(w, "Internal server error")
		return
	}

	// anthropic.js:36-44. `searchFetch` is the shared pinned node-fetch wire model (lowercased and sorted
	// explicit headers, node-fetch's own defaults, Content-Length for a body, a transport
	// `Connection: close`), which is the same model the recorded wire headers show.
	response, err := searchFetch(request.Context(), searchRequest{
		Method: http.MethodPost,
		URL:    target,
		Headers: map[string]string{
			"content-type":      "application/json",
			"anthropic-version": anthropicCaptionVersion,
			"x-api-key":         proxyKey,
		},
		Body: encoded,
	})
	if err != nil {
		// A REJECTED fetch (refused connection, DNS failure, TLS failure) is a throw in the pinned code, so
		// it lands in the catch and answers the text message -- NOT `{error:true}`, which belongs to a
		// non-ok RESPONSE below. Measured through a real closed port (transport.closedPort).
		anthropicCaptionTextFailure(w, "Internal server error")
		return
	}
	if !sdResponseOK(response) {
		// anthropic.js:46-50 -- the provider's text is read and logged, and then DISCARDED: the answer is
		// the upstream status with `{error:true}`.
		anthropicCaptionJSONError(w, response.Status)
		return
	}

	// anthropic.js:53-54 -- `await result.json()` throws on a non-JSON body, and `content[0].text` throws
	// when `content` is absent, null or has no element 0. Both land in the catch. The two helpers below
	// reproduce JavaScript's INDEX and PROPERTY ACCESS instead of enumerating shapes, because the pinned
	// expression accepts every JSON value and the interesting ones are the surprises: `content` as a STRING
	// is indexable (`"ab"[0]` is `"a"`, whose `.text` is undefined, so the answer is `No caption found`),
	// while `content: [5]` also yields `.text` undefined, and `content: {"0": {...}}` yields that member
	// because a numeric index is the property "0". A Go implementation that guarded on "is it an array"
	// would answer `Internal server error` for the string case and `No caption found` for the numeric-key
	// case -- wrong in both directions, and each direction is recorded.
	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		anthropicCaptionTextFailure(w, "Internal server error")
		return
	}
	contentValue, hasContent := decoded.member("content")
	if !hasContent {
		// `request.body`-style absence is `undefined`, and `undefined[0]` is a TypeError.
		contentValue = orderedNodeJSON{kind: nodeUndefinedKind}
	}
	first, indexed := anthropicCaptionIndex(contentValue)
	if !indexed {
		anthropicCaptionTextFailure(w, "Internal server error")
		return
	}
	textValue, accessed := anthropicCaptionProperty(first, "text")
	if !accessed {
		anthropicCaptionTextFailure(w, "Internal server error")
		return
	}
	// anthropic.js:57-59 -- `if (!caption)`: JavaScript TRUTHINESS, so an empty string, 0, false and null
	// all answer `No caption found`. An ABSENT `text` member is `undefined`, which is falsy too, and it did
	// not throw, so it takes this branch rather than the catch.
	if !pinnedJSTruthy(textValue) {
		anthropicCaptionTextFailure(w, "No caption found")
		return
	}
	// anthropic.js:61 -- `response.json({ caption })` forwards the VALUE, not its string form: a numeric
	// text answers `{"caption":42}` and an object text answers a nested object. `scenario ok.textNumber`
	// pins that, because an implementation using String(caption) would answer `{"caption":"42"}` and a
	// status-only check would not see it.
	answer := nodeObject()
	answer.setMember("caption", textValue)
	output, err := marshalCharacterJSON(answer)
	if err != nil {
		anthropicCaptionTextFailure(w, "Internal server error")
		return
	}
	respondJSONBytes(w, http.StatusOK, output)
}

// anthropicCaptionIndex reproduces JavaScript `value[0]`. The second result is false when the pinned
// expression would THROW (property access on null or undefined); an absent index is `undefined`, which is
// a value and not a throw.
func anthropicCaptionIndex(value orderedNodeJSON) (orderedNodeJSON, bool) {
	if value.isUndefined() || value.isNull() {
		return orderedNodeJSON{}, false
	}
	switch value.kind {
	case 'a':
		if len(value.array) == 0 {
			return orderedNodeJSON{kind: nodeUndefinedKind}, true
		}
		return value.array[0], true
	case 's':
		// JavaScript strings are indexable by UTF-16 code unit. An empty string has no element 0.
		text, _ := value.scalar.(string)
		for _, unit := range []rune(text) {
			return nodeString(string(unit)), true
		}
		return orderedNodeJSON{kind: nodeUndefinedKind}, true
	case 'o':
		// A numeric index on an object is the property "0".
		if member, present := value.member("0"); present {
			return member, true
		}
		return orderedNodeJSON{kind: nodeUndefinedKind}, true
	default:
		// A number, boolean or null scalar has no indexable member: `(5)[0]` is undefined.
		return orderedNodeJSON{kind: nodeUndefinedKind}, true
	}
}

// anthropicCaptionProperty reproduces JavaScript `value.<name>`. The second result is false when the
// pinned expression would THROW; every non-object type yields `undefined` instead (boxing),
// which is a value.
func anthropicCaptionProperty(value orderedNodeJSON, name string) (orderedNodeJSON, bool) {
	if value.isUndefined() || value.isNull() {
		return orderedNodeJSON{}, false
	}
	if member, present := value.member(name); present {
		return member, true
	}
	return orderedNodeJSON{kind: nodeUndefinedKind}, true
}
