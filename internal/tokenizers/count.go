package tokenizers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
)

// ErrNotTiktoken reports that the query model is served by another backend, so the caller
// must dispatch to that backend instead of counting here.
var ErrNotTiktoken = errors.New("tokenizers: model is not served by tiktoken")

// Guesstimate mirrors the pinned fallback used whenever a tokenizer cannot be
// instantiated: Math.ceil(Buffer.byteLength(str, 'utf8') / 3.35).
func Guesstimate(text string) int {
	return int(math.Ceil(float64(len(text)) / 3.35))
}

// MessageEntry is one chat-message property. Key order is preserved because the pinned
// count walks Object.entries(msg) in insertion order.
type MessageEntry struct {
	Key   string
	Value any
}

// Message is one chat message.
type Message []MessageEntry

// DecodeOrderedMessages parses a JSON array of objects while preserving key order.
func DecodeOrderedMessages(raw []byte) ([]Message, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '[' {
		return nil, errors.New("tokenizers: expected a JSON array of messages")
	}
	messages := []Message{}
	for decoder.More() {
		message, err := decodeOrderedMessage(decoder)
		if err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	return messages, nil
}

func decodeOrderedMessage(decoder *json.Decoder) (Message, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil, errors.New("tokenizers: expected a JSON object message")
	}
	message := Message{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("tokenizers: message key is not a string")
		}
		var value any
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		message = append(message, MessageEntry{Key: key, Value: value})
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	return message, nil
}

// CountOpenAIChatTokens reproduces the pinned /api/tokenizers/openai/count arithmetic for
// the tiktoken branch. It returns ErrNotTiktoken when the query model is served by another
// backend.
//
// Two pinned behaviours are easy to get wrong and are reproduced deliberately:
//   - a message value that the tokenizer cannot encode aborts only the rest of that
//     message, keeping what was already added;
//   - the per-model constants come from the *query* model string, not the resolved model.
func (s *TiktokenSet) CountOpenAIChatTokens(queryModel string, messages []Message) (int, error) {
	model := GetTokenizerModel(queryModel)
	encodingName, ok := s.EncodingForModel(model)
	if !ok {
		return 0, fmt.Errorf("%w: %s", ErrNotTiktoken, model)
	}
	encoding, err := s.Encoding(encodingName)
	if err != nil {
		return 0, err
	}

	tokensPerName := 1
	tokensPerMessage := 3
	is0301 := strings.Contains(queryModel, "gpt-3.5-turbo-0301")
	if is0301 {
		tokensPerName = -1
		tokensPerMessage = 4
	}

	total := 0
	for _, message := range messages {
		total += tokensPerMessage
		for _, entry := range message {
			ids, err := encoding.encodeMessageValue(entry.Value)
			if err != nil {
				// The pinned inner catch logs and moves to the next message.
				break
			}
			total += len(ids)
			if entry.Key == "name" {
				total += tokensPerName
			}
		}
	}
	total += 3
	if is0301 {
		total += 9
	}
	return total, nil
}

// encodeMessageValue reproduces the wasm glue's behaviour for a non-string JSON value: a
// string encodes, an empty array encodes to nothing, and every other value fails.
func (t *Tiktoken) encodeMessageValue(value any) ([]int, error) {
	switch typed := value.(type) {
	case string:
		return t.Encode(typed)
	case []any:
		if len(typed) == 0 {
			return nil, nil
		}
	}
	return nil, fmt.Errorf("tokenizers: cannot encode a non-string message value")
}
