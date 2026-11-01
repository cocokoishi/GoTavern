package server

// REMOTE EMBEDDING PRODUCTION: A DECLARED EXCLUSION, ANSWERED EXPLICITLY.
//
// The pinned vector domain can embed text through 20 sources (src/endpoints/vectors.js:22). GoTavern implements
// the two whose vectors arrive PRECOMPUTED in the request body (`webllm`, `koboldcpp`) and the whole persisted
// index format, but it does not perform provider embedding calls. Until this file existed those sources answered
// the same bare 500 a failed provider call produces, which made "not implemented" indistinguishable from "the
// provider failed" -- AGENTS.md 17's exact shape ("an unimplemented branch must be distinguishable from a
// refused one"), and rule 45's ("a boundary may not justify an absence a user can see" without saying so).
//
// The product decision is recorded in docs/remote-embeddings-decision.md: remote embedding production is
// EXCLUDED from this release (option B), because implementing it means nine distinct request families
// (OpenAI-compatible with per-source URLs/auth, nomicai, cohere, palm/MakerSuite, vertexai service-account,
// llamacpp, vllm, ollama, extras), each needing a provider-wire oracle and adapter, to buy a secondary,
// opt-in feature. The exclusion is reversible: a user requirement turns it into a scoped implementation with a
// stated cost.
//
// THIS IS A DECLARED DIVERGENCE FROM PINNED, and it is recorded as one: pinned would call the provider and
// answer 500 only on failure. GoTavern answers 501 with a JSON body that names the source, the reason and the
// decision document, and states that no request was sent. The differential corpus's knownDifferences entry is
// updated in the same change so the annotation and the code cannot disagree.
//
// The branch returns BEFORE any outbound request is constructed: there is no provider call to make, no key to
// read, and no timeout to bound. That is why no network assertion is needed here -- the code path that could
// open a socket does not exist in this branch.

import (
	"errors"
	"fmt"
	"net/http"
)

// vectorExcludedEmbeddingReasons maps every pinned source whose embedding call this release does not perform to
// the reason it is excluded. `webllm` and `koboldcpp` are deliberately absent: they are implemented from
// request-body vectors, and a test asserts they still work.
var vectorExcludedEmbeddingReasons = map[string]string{
	"transformers": "local in-process ONNX inference is a decided architectural boundary (AGENTS.md boundary 2; ARCHITECTURE.md), not a missing adapter",
	"mistral":      "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"openai":       "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"extras":       "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"palm":         "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"togetherai":   "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"nomicai":      "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"cohere":       "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"ollama":       "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"llamacpp":     "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"vllm":         "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"vertexai":     "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"electronhub":  "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"openrouter":   "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"chutes":       "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"nanogpt":      "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"siliconflow":  "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
	"workers_ai":   "remote embedding production is a declared exclusion for this release (docs/remote-embeddings-decision.md)",
}

// vectorEmbeddingExcludedError carries the source so the response can name it. Is() keeps the historical
// sentinel meaningful for callers that only ask "is this the unsupported branch?".
type vectorEmbeddingExcludedError struct {
	source string
	reason string
}

func (err *vectorEmbeddingExcludedError) Error() string {
	return "vector embedding source is excluded: " + err.source
}

func (err *vectorEmbeddingExcludedError) Is(target error) bool {
	return target == errVectorUnsupportedSource
}

// vectorEmbeddingProductionError is the single decision point for "can this source produce vectors here?".
// A KNOWN but excluded source returns the typed error (answered 501 with a reason); an UNKNOWN source returns a
// plain error so the shared catch keeps pinned's 500 for `Unknown vector source` (parity is preserved for a
// source that is not in pinned's SOURCES list either).
func vectorEmbeddingProductionError(source string) error {
	reason, excluded := vectorExcludedEmbeddingReasons[source]
	if excluded {
		return &vectorEmbeddingExcludedError{source: source, reason: reason}
	}
	return fmt.Errorf("Unknown vector source %s", source)
}

// vectorEmbeddingUnsupportedResponse answers the excluded branch: HTTP 501, a JSON object naming the source,
// the reason, the decision document, and the fact that nothing was sent to a provider.
func vectorEmbeddingUnsupportedResponse(w http.ResponseWriter, excluded *vectorEmbeddingExcludedError) {
	respondJSON(w, http.StatusNotImplemented, map[string]any{
		"error":    true,
		"source":   excluded.source,
		"message":  "vector embedding source " + excluded.source + " is not supported by this release: " + excluded.reason + ". No request was sent to any provider. Vector storage and the body-supplied sources (webllm, koboldcpp) are implemented; see docs/remote-embeddings-decision.md.",
		"decision": "docs/remote-embeddings-decision.md",
	})
}

// vectorEmbeddingErrorAs extracts the excluded error, if the branch produced one.
func vectorEmbeddingErrorAs(err error) (*vectorEmbeddingExcludedError, bool) {
	var excluded *vectorEmbeddingExcludedError
	if errors.As(err, &excluded) {
		return excluded, true
	}
	return nil, false
}
