package server

// THE CHAT-COMPLETION SOURCE REGISTRY.
//
// This table is the ONE place a source is routed. Before it, the generate route routed each source up to
// three separate times -- once in the plan chain, once in the transport-failure chain and once in the
// response chain -- and two more times in the /status route. Eleven of those arms were copies that could
// never run (see chat_completions_dispatch_test.go), and nothing in the toolchain could see them: an `if`
// after a `return` is not dead code to `go build` or `go vet`, and two identical arms have identical
// behaviour, so no test driven through the route could tell them apart.
//
// A row is THREE behaviours, and all three are required:
//
//	plan              resolves the upstream request, or the failure that replaces it
//	response          maps the upstream answer back to the caller
//	transportFailure  answers a fetch that threw, which is NOT the same shape for every source
//
// Shared behaviour is a SHARED FUNCTION, not a nil field: the eight sources with byte-identical response
// mapping point at the same function, and so do the twelve that share the generic envelope. Nothing here
// is optional, so "this source has no response mapping" is not expressible.
//
// ADDING A SOURCE: add a row. The constructor below takes all three behaviours positionally, so a row that
// omits one does not compile, and adding a fourth behaviour to chatCompletionSource means adding a fourth
// parameter, which breaks all 24 rows at once -- the omission cannot be silent. A source that answers 501
// (a name the pinned matrix knows but this route does not port) has NO row; see pinnedChatCompletionPlan.
//
// MINIMAX HAS NO ROW ON PURPOSE. It is dispatched at route level, BEFORE this table, because
// pinnedChatCompletionPlan must keep answering 501 for it -- that is what makes the ordering observable
// (TestEveryRouteLevelSourceIsDispatched). Giving it a row would silently move it behind the shared plan.

import (
	"net/http"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// chatCompletionPlanner resolves the upstream request for one source.
type chatCompletionPlanner func(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure)

// chatCompletionResponder maps an upstream answer back to the caller.
type chatCompletionResponder func(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON)

// chatCompletionTransportFailureFunc answers a fetch that threw, in the shape that source's own pinned
// catch uses.
type chatCompletionTransportFailureFunc func(err error) *pinnedChatCompletionFailure

// chatCompletionSource is one row: a name and the three behaviours every source must have.
type chatCompletionSource struct {
	name             string
	plan             chatCompletionPlanner
	response         chatCompletionResponder
	transportFailure chatCompletionTransportFailureFunc
}

// newChatCompletionSource is the only way a row is built. All three behaviours are positional parameters,
// so a row cannot be constructed with one missing, and a new behaviour added to chatCompletionSource breaks
// every row at compile time instead of defaulting to nil.
func newChatCompletionSource(name string, plan chatCompletionPlanner, response chatCompletionResponder, transportFailure chatCompletionTransportFailureFunc) chatCompletionSource {
	return chatCompletionSource{name: name, plan: plan, response: response, transportFailure: transportFailure}
}

// pinnedChatCompletionPlanWithoutAffinity adapts a planner written against (body, directories) to the uniform
// planner contract. The affinity key is the install's cookie secret, and exactly one source folds it into a
// request (fireworks' x-session-affinity); the rest take this adapter so the registry can call every planner
// the same way. The planners keep their two-argument form because their own tests drive them directly.
func pinnedChatCompletionPlanWithoutAffinity(plan func(orderedNodeJSON, startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure)) chatCompletionPlanner {
	return func(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure) {
		return plan(request.body, request.directories)
	}
}

// pinnedChatCompletionSourceRegistry is every source this route routes. Order is not observable (the lookup
// is by name) and is alphabetical only so a reader can find a row.
var pinnedChatCompletionSourceRegistry = []chatCompletionSource{
	// THE EIGHT SOURCES WHOSE PINNED BRANCH CALLS `response.send({error:true})` WITH NO STATUS in its catch,
	// and whose non-2xx answer is the PARSED provider body at 500 rather than the shared 200 envelope.
	newChatCompletionSource(
		chatCompletionSourceAI21,
		pinnedChatCompletionPlanWithoutAffinity(pinnedAI21Plan),
		servePinnedChatCompletionPassThroughResponse,
		pinnedChatCompletionTransportErrorFlagOK,
	),
	newChatCompletionSource(
		chatCompletionSourceAimlapi,
		pinnedChatCompletionPlanWithoutAffinity(pinnedAimlapiPlan),
		servePinnedChatCompletionPassThroughResponse,
		pinnedChatCompletionTransportErrorFlagOK,
	),
	newChatCompletionSource(
		chatCompletionSourceAzure,
		pinnedChatCompletionPlanWithoutAffinity(pinnedAzureOpenAIPlan),
		// AZURE is structurally special: its own catch (500 {error:{message}}, not the shared 502), a
		// parsed body for a 2xx answer and a statusText fallback. See azure_openai_chat.go.
		serveAzureOpenAIChatCompletionResponse,
		pinnedAzureOpenAICatch,
	),
	newChatCompletionSource(
		chatCompletionSourceChutes,
		pinnedChatCompletionPlanWithoutAffinity(pinnedChutesPlan),
		servePinnedChatCompletionPassThroughResponse,
		pinnedChatCompletionTransportErrorFlagOK,
	),
	newChatCompletionSource(
		chatCompletionSourceClaude,
		pinnedChatCompletionPlanWithoutAffinity(pinnedClaudePlan),
		// CLAUDE is structurally special: the content[0].text rewrap with an optional member. Its catch is
		// 500 {error:true}, NOT the shared 502.
		serveClaudeChatCompletionResponse,
		pinnedChatCompletionTransportErrorFlagServerError,
	),
	newChatCompletionSource(
		chatCompletionSourceCohere,
		pinnedChatCompletionPlanWithoutAffinity(pinnedCoherePlan),
		servePinnedChatCompletionPassThroughResponse,
		pinnedChatCompletionTransportErrorFlagOK,
	),
	newChatCompletionSource(
		chatCompletionSourceCustom,
		pinnedCustomChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourceDeepSeek,
		pinnedChatCompletionPlanWithoutAffinity(pinnedDeepSeekPlan),
		servePinnedChatCompletionPassThroughResponse,
		pinnedChatCompletionTransportErrorFlagOK,
	),
	newChatCompletionSource(
		chatCompletionSourceElectronHub,
		pinnedChatCompletionPlanWithoutAffinity(pinnedElectronHubPlan),
		servePinnedChatCompletionPassThroughResponse,
		pinnedChatCompletionTransportErrorFlagOK,
	),
	newChatCompletionSource(
		chatCompletionSourceFW,
		pinnedFireworksChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourceGroq,
		pinnedGroqChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourceMakerSuite,
		pinnedMakerSuitePlan,
		// The two GOOGLE sources share one pinned function: the candidate checks, the two 200-shaped
		// {error:{message}} answers and the {choices,responseContent} rewrap, differing only by the
		// credential mode. See google_chat.go.
		serveMakerSuiteChatCompletionResponse,
		pinnedChatCompletionTransportErrorFlagServerError,
	),
	newChatCompletionSource(
		chatCompletionSourceMistral,
		pinnedChatCompletionPlanWithoutAffinity(pinnedMistralPlan),
		servePinnedChatCompletionPassThroughResponse,
		pinnedChatCompletionTransportErrorFlagOK,
	),
	newChatCompletionSource(
		chatCompletionSourceMoonshot,
		pinnedMoonshotChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourceNG,
		pinnedNanoGPTChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourceOpenAI,
		pinnedOpenAIChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourceOpenRtr,
		pinnedOpenRouterChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourcePerplexity,
		pinnedPerplexityChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourcePollinations,
		pinnedPollinationsChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourceSiliconF,
		pinnedSiliconFlowChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourceVertexAI,
		pinnedVertexAIPlan,
		serveVertexAIChatCompletionResponse,
		pinnedChatCompletionTransportErrorFlagServerError,
	),
	newChatCompletionSource(
		chatCompletionSourceWAI,
		pinnedWorkersAIChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
	newChatCompletionSource(
		chatCompletionSourceXAI,
		pinnedChatCompletionPlanWithoutAffinity(pinnedXAIPlan),
		servePinnedChatCompletionPassThroughResponse,
		pinnedChatCompletionTransportErrorFlagOK,
	),
	newChatCompletionSource(
		chatCompletionSourceZai,
		pinnedZaiChatPlan,
		servePinnedChatCompletionDefaultResponse,
		pinnedChatCompletionTransportBadGateway,
	),
}

// pinnedChatCompletionSourceRows is the lookup the dispatcher uses, built once from the table above.
var pinnedChatCompletionSourceRows = func() map[string]chatCompletionSource {
	rows := make(map[string]chatCompletionSource, len(pinnedChatCompletionSourceRegistry))
	for _, row := range pinnedChatCompletionSourceRegistry {
		rows[row.name] = row
	}
	return rows
}()

// pinnedChatCompletionSourceByName resolves a source name to its row. The bool reports whether the name is
// ROUTED here, which is a different question from whether the pinned matrix knows the name: a known name
// with no row is a source this route has not ported and must answer 501 for, while an unknown name is one
// the pinned backend itself does not route and must answer 400 for.
func pinnedChatCompletionSourceByName(name string) (chatCompletionSource, bool) {
	row, routed := pinnedChatCompletionSourceRows[name]
	return row, routed
}

// validateChatCompletionSourceRegistry refuses a row with a nil behaviour at startup rather than at request
// time. The constructor already makes omission a compile error; this catches an explicit nil, which is the
// one form the type system cannot. It panics rather than returning an error because a nil behaviour here is
// a programming error in a static table, not a runtime condition, and a route that dereferenced it would
// panic mid-request with no clue which row was wrong.
func validateChatCompletionSourceRegistry() {
	for _, row := range pinnedChatCompletionSourceRegistry {
		if row.name == "" {
			panic("chat completion source registry: a row has an empty name")
		}
		if row.plan == nil || row.response == nil || row.transportFailure == nil {
			panic("chat completion source registry: row " + row.name + " has a nil behaviour (plan/response/transportFailure must all be set)")
		}
	}
}

func init() {
	validateChatCompletionSourceRegistry()
}
