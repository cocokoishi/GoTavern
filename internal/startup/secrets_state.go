package startup

// Secrets state, masking and mutation, on top of the ordered-JSON secrets file the migration
// already owns.
//
// There is exactly ONE representation of secrets.json in this repository: the ordered-JSON
// primitives the flat-secrets migration uses (system_prompts.go), so an unknown field on a secret
// entry survives a read and a write untouched (AGENTS.md rule 11) and reads never rewrite the file.
//
// Everything below is pinned by tools/probe-secrets.mjs against the pinned listener and recorded in
// tests/oracle/sillytavern-1.19.0-secrets.json, not derived from reading the source:
//
//   - every SECRET_KEYS value appears in the state map, and a key with no entries is null;
//   - the migration marker is skipped, including by /api/secrets/find, which therefore answers 404
//     for it;
//   - a masked value is the last three characters behind seven placeholders, and a value of ten
//     characters or fewer becomes ten placeholders;
//   - the four exportable keys are never masked, and allowKeysExposure disables masking entirely;
//   - `_readSecretsFile` calls `_ensureSecretsFile` first, so ANY route that reads the file CREATES
//     it when absent (recorded bytes: `{}` with no trailing newline). /delete and /rotate are the
//     two exceptions, because each has its own existsSync guard;
//   - a write re-serializes with four-space indentation and NO trailing newline, deactivates the
//     key's other entries, and defaults an ABSENT label to 'Unlabeled' (a null label stays null);
//   - an entry that is not an object makes the pinned projection throw. /read catches that and
//     answers `{}`; every other route answers 500. This is reproduced rather than papered over,
//     because "silently skip the bad entry" is a different observable.
//
// Mutations take the shared user-content lock and use atomic replacement (AGENTS.md rule 12).

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gofrs/flock"
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

// secretMigrationMarkerKey is SECRET_KEYS._MIGRATED, skipped by every projection.
const secretMigrationMarkerKey = "_migrated"

// ErrMalformedSecretEntry reports the pinned TypeError: an entry that is not an object makes
// `secret.id`, `secret.active` or `secret.value` throw. Callers translate it the way their pinned
// catch does, which is NOT the same for every route.
var ErrMalformedSecretEntry = errors.New("secrets entry is not an object")

// MaskedSecretValue reproduces the pinned getMaskedValue (secrets.js:181). The formula is the
// measured one: seven placeholders then the last three characters, with no visible prefix.
func MaskedSecretValue(value, keyID string, allowKeysExposure bool) string {
	if allowKeysExposure || IsExportableSecretKey(keyID) {
		return value
	}
	const threshold = 10
	const exposedCharacters = 3
	if len(value) <= threshold {
		return strings.Repeat("*", threshold)
	}
	return strings.Repeat("*", threshold-exposedCharacters) + value[len(value)-exposedCharacters:]
}

// IsExportableSecretKey reports membership of the pinned EXPORTABLE_KEYS list.
func IsExportableSecretKey(keyID string) bool {
	for _, exportable := range exportableSecretKeyIDs {
		if exportable == keyID {
			return true
		}
	}
	return false
}

// IsSecretKeyID reports whether keyID is one of the pinned SECRET_KEYS values, i.e. a key the state
// map projects. A key that exists in the file but is not in this list is absent from the state map,
// which is observable through /api/secrets/find.
func IsSecretKeyID(keyID string) bool {
	for _, key := range SecretKeyIDs {
		if key == keyID {
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

// secretsFileHandle is one locked view of the user's secrets file. The lock is held for the whole
// read-modify-write, so two concurrent routes cannot interleave and lose an entry (rule 12).
type secretsFileHandle struct {
	path   string
	lock   *flock.Flock
	object *orderedJSONObject
	exists bool
}

func (handle *secretsFileHandle) close() {
	if handle.lock != nil {
		_ = handle.lock.Close()
		handle.lock = nil
	}
}

// save re-serializes the object exactly as `_writeSecretsFile` does: JSON.stringify(secrets, null, 4)
// with no trailing newline, written through atomic replacement.
func (handle *secretsFileHandle) save() error {
	body, err := marshalNodeJSONIndent(handle.object)
	if err != nil {
		return err
	}
	return atomicReplace(handle.path, body)
}

// openSecretsFile performs the pinned `_readSecretsFile`, which starts with `_ensureSecretsFile`:
// when create is true a missing file is created with the pinned `JSON.stringify({})` bytes, which
// are `{}` with no trailing newline. When create is false a missing file is reported through
// exists=false instead, which is what the two routes with their own existsSync guard need.
func openSecretsFile(directories UserDirectories, create bool) (*secretsFileHandle, error) {
	path, err := secretsFilePath(directories)
	if err != nil {
		return nil, err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve secrets path %s: %w", path, err)
	}
	userRoot, err := filepath.Abs(directories["root"])
	if err != nil {
		return nil, fmt.Errorf("resolve user root %s: %w", directories["root"], err)
	}
	lockRoot, err := canonicalPath(filepath.Dir(userRoot))
	if err != nil {
		return nil, fmt.Errorf("resolve secrets lock root: %w", err)
	}
	if err := ensureResolvedContained(userRoot, absolute); err != nil {
		return nil, fmt.Errorf("secrets file escapes user root %s: %w", userRoot, err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return nil, err
	}
	handle := &secretsFileHandle{path: absolute, lock: lock}

	body, err := os.ReadFile(absolute)
	if errors.Is(err, fs.ErrNotExist) {
		if !create {
			return handle, nil
		}
		if err := atomicReplace(absolute, []byte("{}")); err != nil {
			handle.close()
			return nil, fmt.Errorf("create secrets file %s: %w", absolute, err)
		}
		handle.object = &orderedJSONObject{}
		handle.exists = true
		return handle, nil
	}
	if err != nil {
		handle.close()
		return nil, fmt.Errorf("read secrets file %s: %w", absolute, err)
	}
	// JSON.parse('') throws, and so does JSON.parse on any malformed body: the pinned routes answer
	// 500 (/read answers {}), so an empty file must not be treated as an empty object here.
	decoded, err := decodeOrderedJSON(body)
	if err != nil {
		handle.close()
		return nil, fmt.Errorf("parse secrets file %s: %w", absolute, err)
	}
	object, ok := decoded.(*orderedJSONObject)
	if !ok {
		handle.close()
		return nil, fmt.Errorf("secrets file %s is not a JSON object", absolute)
	}
	handle.object = object
	handle.exists = true
	return handle, nil
}

// secretTruthy is JavaScript truthiness for a decoded JSON value. nodeTruthy alone is not enough:
// nodeJSONString is a defined type and does not match its `case string`.
func secretTruthy(value any) bool {
	switch typed := value.(type) {
	case nodeJSONString:
		return typed != ""
	case nodeJSONNumber:
		return typed != 0
	default:
		return nodeTruthy(value)
	}
}

// secretEntryActive reads `entry.active` the way the pinned code does: property access on a null
// entry throws, property access on a primitive yields undefined.
func secretEntryActive(entry any) (bool, error) {
	switch typed := entry.(type) {
	case nil:
		return false, ErrMalformedSecretEntry
	case *orderedJSONObject:
		active, present := typed.get("active")
		if !present {
			return false, nil
		}
		return secretTruthy(active), nil
	default:
		return false, nil
	}
}

// secretEntryIdentifier reads `entry.id`, returning hasID=false for a primitive entry (undefined).
func secretEntryIdentifier(entry any) (any, bool, error) {
	switch typed := entry.(type) {
	case nil:
		return nil, false, ErrMalformedSecretEntry
	case *orderedJSONObject:
		identifier, present := typed.get("id")
		return identifier, present, nil
	default:
		return nil, false, nil
	}
}

// secretIdentifiersEqual reproduces `s.id === id` for JSON scalars. Objects never compare equal,
// because JavaScript compares them by reference.
func secretIdentifiersEqual(entryIdentifier any, wanted any) bool {
	switch left := entryIdentifier.(type) {
	case nodeJSONString:
		right, ok := wanted.(nodeJSONString)
		return ok && left == right
	case nodeJSONNumber:
		right, ok := wanted.(nodeJSONNumber)
		return ok && left == right
	case bool:
		right, ok := wanted.(bool)
		return ok && left == right
	case nil:
		return wanted == nil
	default:
		return false
	}
}

// findSecretEntry reproduces `secretArray.findIndex(s => id ? s.id === id : s.active)`. It returns
// -1 when nothing matches.
func findSecretEntry(list orderedJSONArray, identifier any, hasIdentifier bool) (int, error) {
	for index, entry := range list {
		if hasIdentifier {
			entryIdentifier, present, err := secretEntryIdentifier(entry)
			if err != nil {
				return -1, err
			}
			if present && secretIdentifiersEqual(entryIdentifier, identifier) {
				return index, nil
			}
			continue
		}
		active, err := secretEntryActive(entry)
		if err != nil {
			return -1, err
		}
		if active {
			return index, nil
		}
	}
	return -1, nil
}

// secretEntryObject narrows an entry for a write. Assigning a property on a primitive throws in the
// pinned ES module (strict mode), which is a 500 for every caller that writes.
func secretEntryObject(entry any) (*orderedJSONObject, error) {
	object, ok := entry.(*orderedJSONObject)
	if !ok {
		return nil, ErrMalformedSecretEntry
	}
	return object, nil
}

// secretArrayForRead returns the file's array for keyID and whether it is a usable (non-empty) array.
func secretArrayForRead(object *orderedJSONObject, keyID string) (orderedJSONArray, bool) {
	value, present := object.get(keyID)
	list, isList := value.(orderedJSONArray)
	if !present || !isList || len(list) == 0 {
		return nil, false
	}
	return list, true
}

// secretArrayForMutation returns the file's array for keyID, INCLUDING an empty one. The read
// projection treats an empty array as "no entries", but `_validateSecretKey` does not: a delete on an
// existing-but-empty array passes validation and then REMOVES the key from the file. The oracle pins
// exactly that through the `_migrated` marker, which is an empty array in the seeded file.
func secretArrayForMutation(object *orderedJSONObject, keyID string) (orderedJSONArray, bool) {
	value, present := object.get(keyID)
	list, isList := value.(orderedJSONArray)
	if !present || !isList {
		return nil, false
	}
	return list, true
}

// stateProjection builds the pinned getSecretState object: one member per SECRET_KEYS value in
// pinned order, null when the key has no entries, and each entry projected to id/value/label/active.
// A field the source entry does not have is OMITTED, because the pinned object literal assigns
// `undefined` and JSON.stringify drops undefined members.
func stateProjection(object *orderedJSONObject, allowKeysExposure bool) (*orderedJSONObject, error) {
	state := &orderedJSONObject{}
	for _, keyID := range SecretKeyIDs {
		if keyID == secretMigrationMarkerKey {
			continue
		}
		list, usable := secretArrayForRead(object, keyID)
		if !usable {
			state.set(keyID, nil)
			continue
		}
		projected := make(orderedJSONArray, 0, len(list))
		for _, entry := range list {
			entryObject, err := secretEntryObject(entry)
			if err != nil {
				return nil, err
			}
			value, valuePresent, err := projectedSecretValue(entryObject, keyID, allowKeysExposure)
			if err != nil {
				return nil, err
			}
			projected = append(projected, projectSecretEntry(entryObject, value, valuePresent))
		}
		state.set(keyID, projected)
	}
	return state, nil
}

// projectedSecretValue is `this.getMaskedValue(secret.value, key)`. getMaskedValue reads
// `value.length` and `value.slice`, so a non-string value throws unless masking is bypassed; with
// masking bypassed the value is returned as-is, and an absent value stays undefined (omitted).
func projectedSecretValue(entry *orderedJSONObject, keyID string, allowKeysExposure bool) (any, bool, error) {
	raw, present := entry.get("value")
	if allowKeysExposure || IsExportableSecretKey(keyID) {
		return raw, present, nil
	}
	text, isString := raw.(nodeJSONString)
	if !present || !isString {
		return nil, false, ErrMalformedSecretEntry
	}
	return nodeJSONString(MaskedSecretValue(string(text), keyID, false)), true, nil
}

// projectSecretEntry keeps exactly the four fields the pinned state map projects, in that order.
func projectSecretEntry(entry *orderedJSONObject, value any, valuePresent bool) *orderedJSONObject {
	projected := &orderedJSONObject{}
	if id, present := entry.get("id"); present {
		projected.set("id", id)
	}
	if valuePresent {
		projected.set("value", value)
	}
	if label, present := entry.get("label"); present {
		projected.set("label", label)
	}
	if active, present := entry.get("active"); present {
		projected.set("active", active)
	}
	return projected
}

// ReadSecretState reproduces the /api/secrets/read body. It creates a missing secrets file, because
// the pinned _readSecretsFile does, and that side effect is recorded in the oracle.
func ReadSecretState(directories UserDirectories, allowKeysExposure bool) ([]byte, error) {
	handle, err := openSecretsFile(directories, true)
	if err != nil {
		return nil, err
	}
	defer handle.close()
	state, err := stateProjection(handle.object, allowKeysExposure)
	if err != nil {
		return nil, err
	}
	return marshalNodeJSONCompact(state)
}

// SecretStatePresence reproduces `!state[key]` for the routes that gate on it (/find). It performs
// the FULL projection first, because getSecretState is what throws on a malformed entry, and it
// reports presence only for keys the state map actually projects: a file key outside SECRET_KEYS is
// absent, and so is the migration marker.
func SecretStatePresence(directories UserDirectories, allowKeysExposure bool, keyID string) (bool, error) {
	handle, err := openSecretsFile(directories, true)
	if err != nil {
		return false, err
	}
	defer handle.close()
	state, err := stateProjection(handle.object, allowKeysExposure)
	if err != nil {
		return false, err
	}
	value, present := state.get(keyID)
	if !present {
		return false, nil
	}
	return value != nil, nil
}

// ReadActiveSecrets reproduces getAllSecrets (secrets.js:475): one member per file key that holds a
// non-empty array, carrying the first ACTIVE entry's raw value, in file order. Non-array members are
// skipped, the migration marker is skipped, and a key whose active entry has no value is omitted
// (the pinned assignment stores undefined, which JSON.stringify drops).
func ReadActiveSecrets(directories UserDirectories) ([]byte, error) {
	handle, err := openSecretsFile(directories, true)
	if err != nil {
		return nil, err
	}
	defer handle.close()
	result := &orderedJSONObject{}
	for _, member := range javascriptOrderedMembers(handle.object.members) {
		if member.key == secretMigrationMarkerKey {
			continue
		}
		list, isList := member.value.(orderedJSONArray)
		if !isList || len(list) == 0 {
			continue
		}
		activeIndex, err := findSecretEntry(list, nil, false)
		if err != nil {
			return nil, err
		}
		if activeIndex < 0 {
			continue
		}
		active, err := secretEntryObject(list[activeIndex])
		if err != nil {
			return nil, err
		}
		value, present := active.get("value")
		if !present {
			continue
		}
		result.set(member.key, value)
	}
	return marshalNodeJSONCompact(result)
}

// ReadSecretValue reproduces readSecret(key, id) (secrets.js:268): the matching entry's value, or an
// empty string when nothing matches. `activeSecret?.value || ”` also turns a falsy value into an
// empty string.
func ReadSecretValue(directories UserDirectories, keyID string, identifier any, hasIdentifier bool) (any, error) {
	handle, err := openSecretsFile(directories, false)
	if err != nil {
		return nil, err
	}
	defer handle.close()
	if !handle.exists {
		return "", nil
	}
	list, usable := secretArrayForRead(handle.object, keyID)
	if !usable {
		return "", nil
	}
	index, err := findSecretEntry(list, identifier, hasIdentifier)
	if err != nil {
		return nil, err
	}
	if index < 0 {
		return "", nil
	}
	entry, err := secretEntryObject(list[index])
	if err != nil {
		return nil, err
	}
	value, present := entry.get("value")
	if !present || !secretTruthy(value) {
		return "", nil
	}
	return value, nil
}

// ReadSecretString reproduces `const key = readSecret(directories, KEY)` followed by `if (!key)` and
// the `${key}` interpolation the provider routes use for an Authorization header: an absent or falsy
// secret is the empty string, and any other value is JavaScript String() of it.
func ReadSecretString(directories UserDirectories, keyID string) (string, error) {
	value, err := ReadSecretValue(directories, keyID, nil, false)
	if err != nil {
		return "", err
	}
	if text, isString := value.(string); isString {
		return text, nil
	}
	if text, isNodeString := value.(nodeJSONString); isNodeString {
		return string(text), nil
	}
	if number, isNumber := value.(nodeJSONNumber); isNumber {
		return javascriptNumberString(float64(number)), nil
	}
	if boolean, isBool := value.(bool); isBool {
		return strconv.FormatBool(boolean), nil
	}
	return "", nil
}

// WriteSecret appends one entry to a key's list and returns its generated id, reproducing
// SecretManager.writeSecret's effect on disk: every existing entry for the key is deactivated
// first, and the file keeps every unknown field it already had.
func WriteSecret(directories UserDirectories, keyID, value string, label any, labelPresent bool) (string, error) {
	handle, err := openSecretsFile(directories, true)
	if err != nil {
		return "", err
	}
	defer handle.close()
	existing, present := handle.object.get(keyID)
	list, isList := existing.(orderedJSONArray)
	if !present || !isList {
		list = orderedJSONArray{}
	}
	for _, item := range list {
		entry, err := secretEntryObject(item)
		if err != nil {
			return "", err
		}
		entry.set("active", false)
	}
	id, err := newSecretUUID()
	if err != nil {
		return "", err
	}
	if !labelPresent {
		label = nodeJSONString("Unlabeled")
	}
	entry := &orderedJSONObject{members: []orderedJSONMember{
		{key: "id", value: nodeJSONString(id)},
		{key: "value", value: nodeJSONString(value)},
		{key: "label", value: label},
		{key: "active", value: true},
	}}
	list = append(list, entry)
	handle.object.set(keyID, list)
	if err := handle.save(); err != nil {
		return "", err
	}
	return id, nil
}

// DeleteSecret reproduces deleteSecret(key, id) (secrets.js:230). A missing file is a no-op that
// must not create one; a key that is not an array is a no-op that must not write; otherwise the file
// is rewritten even when nothing matched, exactly as the pinned code does.
func DeleteSecret(directories UserDirectories, keyID string, identifier any, hasIdentifier bool) error {
	handle, err := openSecretsFile(directories, false)
	if err != nil {
		return err
	}
	defer handle.close()
	if !handle.exists {
		return nil
	}
	list, usable := secretArrayForMutation(handle.object, keyID)
	if !usable {
		return nil
	}
	index, err := findSecretEntry(list, identifier, hasIdentifier)
	if err != nil {
		return err
	}
	if index >= 0 {
		list = append(list[:index], list[index+1:]...)
		handle.object.set(keyID, list)
	}
	// Reactivate the first entry when the deletion removed the active one.
	if len(list) > 0 {
		activeFound := false
		for _, item := range list {
			active, err := secretEntryActive(item)
			if err != nil {
				return err
			}
			if active {
				activeFound = true
				break
			}
		}
		if !activeFound {
			first, err := secretEntryObject(list[0])
			if err != nil {
				return err
			}
			first.set("active", true)
		}
	} else {
		handle.object.delete(keyID)
	}
	return handle.save()
}

// RotateSecret reproduces rotateSecret(key, id) (secrets.js:289): deactivate every entry, activate
// the requested one, and write. Like deleteSecret it starts with an existsSync guard, so a missing
// file is a no-op that must not create one; an unknown id returns without writing.
func RotateSecret(directories UserDirectories, keyID string, identifier any) error {
	handle, err := openSecretsFile(directories, false)
	if err != nil {
		return err
	}
	defer handle.close()
	if !handle.exists {
		return nil
	}
	list, usable := secretArrayForMutation(handle.object, keyID)
	if !usable {
		return nil
	}
	index, err := findSecretEntry(list, identifier, true)
	if err != nil {
		return err
	}
	if index < 0 {
		return nil
	}
	for _, item := range list {
		entry, err := secretEntryObject(item)
		if err != nil {
			return err
		}
		entry.set("active", false)
	}
	target, err := secretEntryObject(list[index])
	if err != nil {
		return err
	}
	target.set("active", true)
	return handle.save()
}

// RenameSecret reproduces renameSecret(key, id, label) (secrets.js:320). The label is stored as the
// submitted JSON value: only its truthiness is checked, so a number is written as a number.
func RenameSecret(directories UserDirectories, keyID string, identifier any, label any) error {
	handle, err := openSecretsFile(directories, true)
	if err != nil {
		return err
	}
	defer handle.close()
	list, usable := secretArrayForMutation(handle.object, keyID)
	if !usable {
		return nil
	}
	index, err := findSecretEntry(list, identifier, true)
	if err != nil {
		return err
	}
	if index < 0 {
		return nil
	}
	target, err := secretEntryObject(list[index])
	if err != nil {
		return err
	}
	target.set("label", label)
	return handle.save()
}

// WriteFileAtomic replaces path with body through the same atomic replacement the secrets migration
// uses, so a caller outside this package does not need a second write path (rule 12).
func WriteFileAtomic(path string, body []byte) error {
	return atomicReplace(path, body)
}

// DecodeJSONValue decodes one request-body JSON value into this package's ordered-JSON
// representation, so a route can hand a value to the storage layer without introducing a second
// representation of the same JSON (AGENTS.md rule 10/11). present is false for an absent member.
func DecodeJSONValue(raw []byte) (any, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	value, err := decodeOrderedJSON(raw)
	if err != nil {
		return nil, true, err
	}
	return value, true, nil
}

// SecretFindResponse serializes the pinned /api/secrets/find body `{ value }` with the Node-compatible
// serializer, because a secret value can be any JSON type and `response.send` preserves it.
func SecretFindResponse(value any) ([]byte, error) {
	object := &orderedJSONObject{members: []orderedJSONMember{{key: "value", value: value}}}
	return marshalNodeJSONCompact(object)
}
