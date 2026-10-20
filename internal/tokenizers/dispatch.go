package tokenizers

import "strings"

// This file ports the pinned tokenizer selection, which lives in two places upstream:
// getTokenizerModel() at src/endpoints/tokenizers.js:440 and the substring chain the
// openai/* routes run before falling through to it (src/endpoints/tokenizers.js:770-841).
// Both are order-sensitive, so the branches below keep the pinned order.

// Tokenizer families the pinned server can select.
const (
	FamilyTiktoken    = "tiktoken"
	FamilyClaude      = "claude"
	FamilyLlama3      = "llama3"
	FamilyLlama       = "llama"
	FamilyMistral     = "mistral"
	FamilyYi          = "yi"
	FamilyGemma       = "gemma"
	FamilyJamba       = "jamba"
	FamilyQwen2       = "qwen2"
	FamilyCommandR    = "command-r"
	FamilyCommandA    = "command-a"
	FamilyNemo        = "nemo"
	FamilyDeepseek    = "deepseek"
	FamilyNerdstash   = "nerdstash"
	FamilyNerdstashV2 = "nerdstash_v2"
)

// textCompletionModels is TEXT_COMPLETION_MODELS from src/endpoints/tokenizers.js:31.
var textCompletionModels = []string{
	"gpt-3.5-turbo-instruct",
	"gpt-3.5-turbo-instruct-0914",
	"text-davinci-003",
	"text-davinci-002",
	"text-davinci-001",
	"text-curie-001",
	"text-babbage-001",
	"text-ada-001",
	"code-davinci-002",
	"code-davinci-001",
	"code-cushman-002",
	"code-cushman-001",
	"text-davinci-edit-001",
	"code-davinci-edit-001",
	"text-embedding-ada-002",
	"text-similarity-davinci-001",
	"text-similarity-curie-001",
	"text-similarity-babbage-001",
	"text-similarity-ada-001",
	"text-search-davinci-doc-001",
	"text-search-curie-doc-001",
	"text-search-babbage-doc-001",
	"text-search-ada-doc-001",
	"code-search-babbage-code-001",
	"code-search-ada-code-001",
}

// GetTokenizerModel ports getTokenizerModel() from the pinned source. It returns a
// tokenizer name, not an encoding name; tiktoken encodings are then resolved from the
// pinned model_to_encoding table.
func GetTokenizerModel(requestModel string) string {
	if requestModel == "o1" || strings.Contains(requestModel, "o1-preview") || strings.Contains(requestModel, "o1-mini") || strings.Contains(requestModel, "o3-mini") {
		return "o1"
	}
	if strings.Contains(requestModel, "gpt-5") || strings.Contains(requestModel, "gpt-6-astra") || strings.Contains(requestModel, "o3") || strings.Contains(requestModel, "o4-mini") {
		return "o1"
	}
	if strings.Contains(requestModel, "gpt-4o") || strings.Contains(requestModel, "chatgpt-4o-latest") {
		return "gpt-4o"
	}
	if strings.Contains(requestModel, "gpt-4.1") || strings.Contains(requestModel, "gpt-4.5") {
		return "gpt-4o"
	}
	if strings.Contains(requestModel, "gpt-4-32k") {
		return "gpt-4-32k"
	}
	if strings.Contains(requestModel, "gpt-4") {
		return "gpt-4"
	}
	if strings.Contains(requestModel, "gpt-3.5-turbo-0301") {
		return "gpt-3.5-turbo-0301"
	}
	if strings.Contains(requestModel, "gpt-3.5-turbo") {
		return "gpt-3.5-turbo"
	}
	for _, model := range textCompletionModels {
		if requestModel == model {
			return requestModel
		}
	}
	if strings.Contains(requestModel, "claude") {
		return FamilyClaude
	}
	if strings.Contains(requestModel, "llama3") || strings.Contains(requestModel, "llama-3") {
		return FamilyLlama3
	}
	if strings.Contains(requestModel, "llama") {
		return FamilyLlama
	}
	if strings.Contains(requestModel, "mistral") {
		return FamilyMistral
	}
	if strings.Contains(requestModel, "yi") {
		return FamilyYi
	}
	if strings.Contains(requestModel, "deepseek") {
		return FamilyDeepseek
	}
	if strings.Contains(requestModel, "gemma") || strings.Contains(requestModel, "gemini") || strings.Contains(requestModel, "learnlm") {
		return FamilyGemma
	}
	if strings.Contains(requestModel, "jamba") {
		return FamilyJamba
	}
	if strings.Contains(requestModel, "qwen2") {
		return FamilyQwen2
	}
	if strings.Contains(requestModel, "command-r") {
		return FamilyCommandR
	}
	if strings.Contains(requestModel, "command-a") {
		return FamilyCommandA
	}
	if strings.Contains(requestModel, "nemo") {
		return FamilyNemo
	}
	return "gpt-3.5-turbo"
}

// OpenAITokenizerFamily ports the substring chain that the pinned openai/encode and
// openai/decode routes run before falling through to GetTokenizerModel. A model that
// matches nothing in the chain is served by tiktoken.
func OpenAITokenizerFamily(queryModel string) string {
	switch {
	case strings.Contains(queryModel, "llama3") || strings.Contains(queryModel, "llama-3"):
		return FamilyLlama3
	case strings.Contains(queryModel, "llama"):
		return FamilyLlama
	case strings.Contains(queryModel, "mistral"):
		return FamilyMistral
	case strings.Contains(queryModel, "yi"):
		return FamilyYi
	case strings.Contains(queryModel, "claude"):
		return FamilyClaude
	case strings.Contains(queryModel, "gemma") || strings.Contains(queryModel, "gemini"):
		return FamilyGemma
	case strings.Contains(queryModel, "jamba"):
		return FamilyJamba
	case strings.Contains(queryModel, "qwen2"):
		return FamilyQwen2
	case strings.Contains(queryModel, "command-r"):
		return FamilyCommandR
	case strings.Contains(queryModel, "command-a"):
		return FamilyCommandA
	case strings.Contains(queryModel, "nemo"):
		return FamilyNemo
	case strings.Contains(queryModel, "deepseek"):
		return FamilyDeepseek
	}
	return FamilyTiktoken
}
