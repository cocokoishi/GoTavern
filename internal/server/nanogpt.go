package server

// Pinned NanoGPT credits route, from src/endpoints/nanogpt.js:36:
//
//	POST /api/nanogpt/credits
//
// The handler issues two parallel provider requests with Promise.allSettled
// (POST /check-balance and GET /subscription/v1/usage), requires the balance request to be
// fulfilled AND ok (otherwise 500 sendStatus), and normalises the payload into
// {usd_balance, nano_balance, subscription}. The subscription block is only emitted when the
// usage request succeeded and `active` is truthy; every numeric field goes through
// `parseNumber` (Number(value), 0 when not finite), and the two usage buckets go through
// normalizeUsage (null unless the value is an object).
//
// Evidence: tools/probe-nanogpt.mjs records tests/oracle/sillytavern-1.19.0-nanogpt.json against
// the pinned server with node-fetch replaced by a controlled peer; internal/server/nanogpt_test.go
// replays it. Because the two fetches are concurrent, the fixture and the replay compare the
// outbound requests as a SET and classify their order as shape.
//
// DEFERRED this round, recorded in the fixture knownDifferences: /api/sprites/{upload,upload-zip},
// /api/data-maid/* and /api/avatars/upload. avatars/upload re-encodes through Jimp (crop/cover/PNG)
// so byte parity needs a codec decision; sprites/upload-zip and the data-maid routes need multipart
// part recording plus the DataMaidService token flow. sprites/upload itself is a plain byte copy
// and is implementable, but was not reached this round; it is not claimed.

import (
	"math"
	"net/http"
	"strconv"
	"sync"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// nanogptCreditsAPIURL is its own seam because the existing NanoGPT seam in openai_models.go
// points at the host root (its routes append /api/v1/...), while credits.js appends the paths to
// the /api base directly.
func nanogptCreditsAPIURL() string {
	return sdSeamURL("GOTAVERN_NANOGPT_CREDITS_URL", "https://nano-gpt.com/api")
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerNanoGPTRoutes)
}

func registerNanoGPTRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/nanogpt/credits", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveNanoGPTCredits(w, r)
	})
}

// nanogptParseNumber is parseNumber: Number(value), 0 when the result is not finite.
func nanogptParseNumber(value orderedNodeJSON) orderedNodeJSON {
	number := nanogptNumber(value)
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return nodeNumber(0)
	}
	return nodeNumber(number)
}

// nanogptNumber is the JS Number() coercion for the JSON shapes this route can see.
func nanogptNumber(value orderedNodeJSON) float64 {
	switch value.kind {
	case 'v':
		if number, ok := value.scalar.(float64); ok {
			return number
		}
		return 0
	case 'n':
		// Number(null) is 0.
		return 0
	case 'b':
		if flag, ok := value.scalar.(bool); ok && flag {
			return 1
		}
		return 0
	case 'a':
		if len(value.array) == 0 {
			return 0
		}
		return nanogptNumber(value.array[0])
	case 's':
		text, _ := value.scalar.(string)
		if text == "" {
			return 0
		}
		number, err := strconv.ParseFloat(sdTrimJavaScriptSpace(text), 64)
		if err != nil {
			return math.NaN()
		}
		return number
	case 'u':
		return math.NaN()
	default:
		return math.NaN()
	}
}

// nanogptNormalizeUsage is normalizeUsage: null unless the value is a non-null object.
func nanogptNormalizeUsage(value orderedNodeJSON) orderedNodeJSON {
	if value.isUndefined() || value.kind != 'o' {
		return orderedNodeJSON{kind: 'n'}
	}
	usage := nodeObject()
	usage.setMember("used", nanogptParseNumber(backendsOptionalMember(value, "used")))
	usage.setMember("remaining", nanogptParseNumber(backendsOptionalMember(value, "remaining")))
	usage.setMember("percentUsed", nanogptParseNumber(backendsOptionalMember(value, "percentUsed")))
	usage.setMember("resetAt", nanogptParseNumber(backendsOptionalMember(value, "resetAt")))
	return usage
}

// serveNanoGPTCredits is nanogpt.js:36.
func (runtime *accountRuntime) serveNanoGPTCredits(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_nanogpt")
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	headers := map[string]string{
		"accept":    "application/json",
		"x-api-key": key,
	}
	var (
		waitGroup         sync.WaitGroup
		balanceResponse   *outboundResponseAlias
		balanceOK         bool
		balanceErr        error
		subscriptionBody  orderedNodeJSON
		subscriptionOK    bool
		subscriptionParse bool
		subscriptionErr   error
	)
	waitGroup.Add(2)
	go func() {
		defer waitGroup.Done()
		balanceResponse, balanceErr = searchFetch(request.Context(), searchRequest{
			Method:  http.MethodPost,
			URL:     nanogptCreditsAPIURL() + "/check-balance",
			Headers: headers,
		})
		if balanceErr == nil && balanceResponse != nil {
			balanceOK = sdResponseOK(balanceResponse)
		}
	}()
	go func() {
		defer waitGroup.Done()
		subscriptionResponse, subscriptionResultOK, requestErr := backendsGet(request, nanogptCreditsAPIURL()+"/subscription/v1/usage", headers)
		if requestErr != nil {
			subscriptionErr = requestErr
			return
		}
		subscriptionOK = subscriptionResultOK
		if !subscriptionResultOK {
			return
		}
		subscriptionBody, subscriptionParse = sdReadJSON(subscriptionResponse)
	}()
	waitGroup.Wait()
	if balanceErr != nil || !balanceOK || balanceResponse == nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	balanceData, balanceParsed := sdReadJSON(balanceResponse)
	if !balanceParsed {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	result := nodeObject()
	result.setMember("usd_balance", nanogptParseNumber(backendsOptionalMember(balanceData, "usd_balance")))
	result.setMember("nano_balance", nanogptParseNumber(backendsOptionalMember(balanceData, "nano_balance")))
	subscription := orderedNodeJSON{kind: 'n'}
	if subscriptionOK {
		if subscriptionErr != nil || !subscriptionParse {
			backendsStatus(w, http.StatusInternalServerError)
			return
		}
		if pinnedJSTruthy(backendsOptionalMember(subscriptionBody, "active")) {
			block := nodeObject()
			block.setMember("active", nodeBool(true))
			block.setMember("state", nodeString(nanogptJSStringOrEmpty(subscriptionBody, "state")))
			block.setMember("allowOverage", nodeBool(pinnedJSTruthy(backendsOptionalMember(subscriptionBody, "allowOverage"))))
			periodSource := backendsOptionalMember(subscriptionBody, "period")
			period := nodeObject()
			period.setMember("currentPeriodEnd", nodeString(nanogptJSStringOrEmpty(periodSource, "currentPeriodEnd")))
			block.setMember("period", period)
			limitsSource := backendsOptionalMember(subscriptionBody, "limits")
			limits := nodeObject()
			limits.setMember("weeklyInputTokens", nanogptParseNumber(backendsOptionalMember(limitsSource, "weeklyInputTokens")))
			limits.setMember("dailyInputTokens", nanogptParseNumber(backendsOptionalMember(limitsSource, "dailyInputTokens")))
			limits.setMember("dailyImages", nanogptParseNumber(backendsOptionalMember(limitsSource, "dailyImages")))
			block.setMember("limits", limits)
			block.setMember("weekly_tokens", nanogptNormalizeUsage(backendsOptionalMember(subscriptionBody, "weeklyInputTokens")))
			block.setMember("daily_tokens", nanogptNormalizeUsage(backendsOptionalMember(subscriptionBody, "dailyInputTokens")))
			block.setMember("daily_images", nanogptNormalizeUsage(backendsOptionalMember(subscriptionBody, "dailyImages")))
			subscription = block
		}
	}
	result.setMember("subscription", subscription)
	searchJSON(w, result)
}

// nanogptJSStringOrEmpty is `String(value || ”)` for a member of a possibly missing object.
func nanogptJSStringOrEmpty(container orderedNodeJSON, key string) string {
	value := backendsOptionalMember(container, key)
	if !pinnedJSTruthy(value) {
		return ""
	}
	text, err := pinnedJSStringValue(value)
	if err != nil {
		return ""
	}
	return text
}

var _ = startup.UserDirectories{}
