package startup

// Secrets state and masking, on top of the ordered-JSON secrets file the migration already owns.
//
// There is exactly ONE representation of secrets.json in this repository: the ordered-JSON
// primitives the flat-secrets migration uses (system_prompts.go), so an unknown field on a secret
// entry survives a read and a write untouched (AGENTS.md rule 11) and reads never rewrite the file
// (asserted by the probe, which is what gives the retention rule a baseline).
//
// The values below are pinned by tools/probe-secrets.mjs, not derived from the source:
//   - every SECRET_KEYS value appears in the state map, and a key with no entries is null;
//   - the migration marker is skipped;
//   - a masked value is the last three characters behind seven placeholders, with no visible
//     prefix, and a value of ten characters or fewer becomes ten placeholders;
//   - the four exportable keys are never masked, and allowKeysExposure disables masking entirely.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// SecretKeyIDs is the pinned SECRET_KEYS value order (src/endpoints/secrets.js:9). The order is
// observable: /api/secrets/read returns the object in this order.
var SecretKeyIDs = []string{
	"_migrated",
	"api_key_horde",
	"api_key_mancer",
	"api_key_vllm",
	"api_key_aphrodite",
	"api_key_tabby",
	"api_key_openai",
	"api_key_novel",
	"api_key_claude",
	"deepl",
	"libre",
	"libre_url",
	"lingva_url",
	"api_key_openrouter",
	"api_key_ai21",
	"oneringtranslator_url",
	"deeplx_url",
	"api_key_makersuite",
	"api_key_vertexai",
	"api_key_serpapi",
	"api_key_togetherai",
	"api_key_mistralai",
	"api_key_custom",
	"api_key_ooba",
	"api_key_infermaticai",
	"api_key_dreamgen",
	"api_key_nomicai",
	"api_key_koboldcpp",
	"api_key_llamacpp",
	"api_key_cohere",
	"api_key_perplexity",
	"api_key_groq",
	"api_key_azure_tts",
	"api_key_featherless",
	"api_key_huggingface",
	"api_key_stability",
	"api_key_custom_openai_tts",
	"api_key_tavily",
	"api_key_chutes",
	"api_key_electronhub",
	"api_key_nanogpt",
	"api_key_bfl",
	"api_key_comfy_runpod",
	"api_key_falai",
	"api_key_generic",
	"api_key_deepseek",
	"api_key_serper",
	"api_key_aimlapi",
	"api_key_xai",
	"api_key_fireworks",
	"vertexai_service_account_json",
	"api_key_minimax",
	"minimax_group_id",
	"api_key_moonshot",
	"api_key_cometapi",
	"api_key_azure_openai",
	"api_key_zai",
	"api_key_siliconflow",
	"api_key_elevenlabs",
	"api_key_pollinations",
	"volcengine_app_id",
	"volcengine_access_key",
	"api_key_workers_ai",
}

// exportableSecretKeyIDs is the pinned EXPORTABLE_KEYS list (secrets.js:101).
var exportableSecretKeyIDs = []string{
	"libre_url",
	"lingva_url",
	"oneringtranslator_url",
	"deeplx_url",
}

// MaskedSecretValue reproduces the pinned getMaskedValue (secrets.js:181). The formula is the
// measured one: seven placeholders then the last three characters, with no visible prefix.
func MaskedSecretValue(value, keyID string, allowKeysExposure bool) string {
	if allowKeysExposure || isExportableSecretKey(keyID) {
		return value
	}
	const threshold = 10
	const exposedCharacters = 3
	if len(value) <= threshold {
		return strings.Repeat("*", threshold)
	}
	return strings.Repeat("*", threshold-exposedCharacters) + value[len(value)-exposedCharacters:]
}

func isExportableSecretKey(keyID string) bool {
	for _, exportable := range exportableSecretKeyIDs {
		if exportable == keyID {
			return true
		}
	}
	return false
}

// secretsFilePath is the pinned per-user location (SECRETS_FILE = 'secrets.json').
func secretsFilePath(directories UserDirectories) (string, error) {
	root := directories["root"]
	if root == "" {
		return "", errors.New("user directory set is missing root")
	}
	return filepath.Join(root, "secrets.json"), nil
}

// readSecretsFile decodes the ordered secrets object. A missing file is an empty object, which is
// what the pinned `_readSecretsFile` falls back to (the probe pins both the absent and empty
// cases: they are different inputs and both produce the full state map of nulls).
func readSecretsFile(directories UserDirectories) (*orderedJSONObject, error) {
	path, err := secretsFilePath(directories)
	if err != nil {
		return nil, err
	}
	body, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return &orderedJSONObject{}, nil
	}
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return &orderedJSONObject{}, nil
	}
	decoded, err := decodeOrderedJSON(body)
	if err != nil {
		return nil, fmt.Errorf("parse secrets file: %w", err)
	}
	object, ok := decoded.(*orderedJSONObject)
	if !ok {
		return nil, errors.New("secrets file is not a JSON object")
	}
	return object, nil
}

// ReadSecretState reproduces the /api/secrets/read body: an entry for every SECRET_KEYS value in
// pinned order, null when the key has no entries, and each entry projected to id/value/label/active
// with the value masked. The migration marker is skipped.
func ReadSecretState(directories UserDirectories, allowKeysExposure bool) ([]byte, error) {
	secrets, err := readSecretsFile(directories)
	if err != nil {
		return nil, err
	}
	state := &orderedJSONObject{}
	for _, keyID := range SecretKeyIDs {
		if keyID == "_migrated" {
			continue
		}
		entries, present := secrets.get(keyID)
		list, isList := entries.(orderedJSONArray)
		if !present || !isList || len(list) == 0 {
			state.set(keyID, nil)
			continue
		}
		projected := make(orderedJSONArray, 0, len(list))
		for _, entry := range list {
			entryObject, isObject := entry.(*orderedJSONObject)
			if !isObject {
				continue
			}
			projected = append(projected, projectSecretEntry(entryObject, keyID, allowKeysExposure))
		}
		if len(projected) == 0 {
			state.set(keyID, nil)
			continue
		}
		state.set(keyID, projected)
	}
	return marshalNodeJSONCompact(state)
}

// projectSecretEntry keeps exactly the four fields the pinned state map projects, in that order.
func projectSecretEntry(entry *orderedJSONObject, keyID string, allowKeysExposure bool) *orderedJSONObject {
	projected := &orderedJSONObject{}
	if id, present := entry.get("id"); present {
		projected.set("id", id)
	}
	value := ""
	if raw, present := entry.get("value"); present {
		if text, isString := raw.(nodeJSONString); isString {
			value = string(text)
		}
	}
	projected.set("value", nodeJSONString(MaskedSecretValue(value, keyID, allowKeysExposure)))
	if label, present := entry.get("label"); present {
		projected.set("label", label)
	} else {
		projected.set("label", nil)
	}
	if active, present := entry.get("active"); present {
		projected.set("active", active)
	} else {
		projected.set("active", nil)
	}
	return projected
}

// WriteSecret appends one entry to a key's list and returns its generated id, reproducing
// SecretManager.writeSecret's effect on disk. The file keeps every unknown field it already had.
func WriteSecret(directories UserDirectories, keyID, value, label string) (string, error) {
	secrets, err := readSecretsFile(directories)
	if err != nil {
		return "", err
	}
	id, err := newSecretUUID()
	if err != nil {
		return "", err
	}
	entry := &orderedJSONObject{members: []orderedJSONMember{
		{key: "id", value: nodeJSONString(id)},
		{key: "value", value: nodeJSONString(value)},
		{key: "label", value: nodeJSONString(label)},
		{key: "active", value: true},
	}}
	existing, present := secrets.get(keyID)
	list, isList := existing.(orderedJSONArray)
	if !present || !isList {
		list = orderedJSONArray{}
	}
	list = append(list, entry)
	secrets.set(keyID, list)

	body, err := marshalNodeJSONIndent(secrets)
	if err != nil {
		return "", err
	}
	path, err := secretsFilePath(directories)
	if err != nil {
		return "", err
	}
	if err := atomicReplace(path, append(body, '\n')); err != nil {
		return "", err
	}
	return id, nil
}

// WriteFileAtomic replaces path with body through the same atomic replacement the secrets migration
// uses, so a caller outside this package does not need a second write path (rule 12).
func WriteFileAtomic(path string, body []byte) error {
	return atomicReplace(path, body)
}
