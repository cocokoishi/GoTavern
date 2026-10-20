package server

// Pinned helpers the chat-completion route depends on: the secrets reader
// (src/endpoints/secrets.js), the YAML include/exclude options and the JSON
// schema flattener (src/util.js), and the JavaScript coercions those paths
// rely on.

import (
	"errors"
	"io/fs"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"

	"github.com/cocokoishi/gotavern/internal/startup"
	"gopkg.in/yaml.v3"
)

// pinnedReadSecret reproduces readSecret(directories, key, id) from
// src/endpoints/secrets.js:448 through SecretManager.readSecret (:268).
//
// The pinned secrets file stores each key as an ARRAY of {id, value, active}
// records, and readSecret returns ” for any other shape. A plain-string value
// therefore yields an empty key rather than an error, which is exactly the
// failure a capture can hide: the Authorization header is still present and
// still looks redacted. That is why the provider-wire capture records
// authorizationKeyVerified instead of trusting the header's presence.
//
// A missing file yields ” without creating one, an unreadable or unparsable
// file is an error (the pinned JSON.parse throws and the route's catch answers
// 502), and a non-object or non-array entry yields ”.
func pinnedReadSecret(directories startup.UserDirectories, key string, id orderedNodeJSON) (orderedNodeJSON, error) {
	root := directories["root"]
	if root == "" {
		return nodeString(""), nil
	}
	body, err := os.ReadFile(filepath.Join(root, "secrets.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return nodeString(""), nil
	}
	if err != nil {
		return nodeUndefined(), err
	}
	secrets, err := decodeOrderedNodeJSON(body)
	if err != nil {
		return nodeUndefined(), err
	}
	secretArray, exists := secrets.member(key)
	if !exists || secretArray.kind != 'a' || len(secretArray.array) == 0 {
		return nodeString(""), nil
	}

	// `secretArray.find(s => id ? s.id === id : s.active)`.
	found := orderedNodeJSON{}
	hasFound := false
	if pinnedJSTruthy(id) {
		for _, candidate := range secretArray.array {
			candidateID, idExists := candidate.member("id")
			if !idExists {
				continue
			}
			if pinnedJSStrictEqual(candidateID, id) {
				found, hasFound = candidate, true
				break
			}
		}
	} else {
		for _, candidate := range secretArray.array {
			active, activeExists := candidate.member("active")
			if activeExists && pinnedJSTruthy(active) {
				found, hasFound = candidate, true
				break
			}
		}
	}
	if !hasFound {
		return nodeString(""), nil
	}
	// `activeSecret?.value || ''`: a falsy value is replaced by the empty string.
	value, valueExists := found.member("value")
	if !valueExists || !pinnedJSTruthy(value) {
		return nodeString(""), nil
	}
	return value, nil
}

// pinnedJSTruthy is JavaScript truthiness for a decoded JSON member, including
// the `undefined` that a missing member produces. The shared orderedNodeJSON
// truthiness helper treats an unknown kind as truthy, which is wrong for
// undefined and silently changes a `secret_id ? ... : s.active` choice.
func pinnedJSTruthy(value orderedNodeJSON) bool {
	if value.isUndefined() {
		return false
	}
	return value.truthy()
}

// pinnedJSStrictEqual is JavaScript's === between two decoded JSON values.
// Objects and arrays compare by reference, and two decoded values are never the
// same reference.
func pinnedJSStrictEqual(left, right orderedNodeJSON) bool {
	if left.kind != right.kind {
		return false
	}
	switch left.kind {
	case 'n', nodeUndefinedKind:
		return true
	case 's', 'b', 'v', 'h':
		return left.scalar == right.scalar
	default:
		return false
	}
}

// pinnedJSGreaterThanZero is `value > 0` with JavaScript's ToNumber coercion,
// which the logprobs adjustment uses.
func pinnedJSGreaterThanZero(value orderedNodeJSON) bool {
	number := pinnedJSToNumber(value)
	return !math.IsNaN(number) && number > 0
}

func pinnedJSToNumber(value orderedNodeJSON) float64 {
	switch value.kind {
	case 'v':
		if number, ok := value.scalar.(float64); ok {
			return number
		}
	case 's':
		if text, ok := value.scalar.(string); ok {
			return pinnedJSStringToNumber(text)
		}
	case 'b':
		if flag, ok := value.scalar.(bool); ok && flag {
			return 1
		}
		return 0
	case 'n':
		return 0
	}
	return math.NaN()
}

func pinnedJSStringToNumber(text string) float64 {
	trimmed := strings.TrimFunc(text, func(character rune) bool {
		switch character {
		case '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\ufeff':
			return true
		}
		return unicode.IsSpace(character)
	})
	if trimmed == "" {
		return 0
	}
	switch trimmed {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if strings.HasPrefix(trimmed, "0x") || strings.HasPrefix(trimmed, "0X") {
		if parsed, err := strconv.ParseUint(trimmed[2:], 16, 64); err == nil {
			return float64(parsed)
		}
		return math.NaN()
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return math.NaN()
	}
	return parsed
}

// pinnedJSURLString reproduces `new URL(value).toString()`: the scheme and host
// are lowercased, a default port is dropped, and an empty path becomes '/'.
// The trailing slash this adds is where the captured `//chat/completions`
// double slash comes from.
func pinnedJSURLString(value orderedNodeJSON) (string, bool) {
	text, err := pinnedJSStringValue(value)
	if err != nil {
		return "", false
	}
	parsed, parseErr := url.Parse(text)
	if parseErr != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		// node-fetch refuses any other protocol before it connects, so the
		// pinned catch answers 502 either way.
		return "", false
	}
	hostname := strings.ToLower(parsed.Hostname())
	port := parsed.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	if strings.Contains(hostname, ":") {
		hostname = "[" + hostname + "]"
	}
	if port != "" {
		hostname += ":" + port
	}
	parsed.Scheme = scheme
	parsed.Host = hostname
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String(), true
}

// pinnedMergeObjectWithYAML reproduces mergeObjectWithYaml (src/util.js:844):
// the value is parsed as YAML and, when it is an object or an array of objects,
// its members are assigned onto the target in order, so an existing member is
// overwritten in place rather than moved to the end. A non-string, an empty
// string, a parse error and every non-object document are all no-ops.
func pinnedMergeObjectWithYAML(target *orderedNodeJSON, value orderedNodeJSON) {
	text, isString := value.stringValue()
	if !isString || text == "" {
		return
	}
	root, err := decodePinnedYAML(text)
	if err != nil {
		return
	}
	for _, entry := range pinnedYAMLAssignments(root) {
		target.setMember(entry.key, entry.value)
	}
}

// pinnedExcludeKeysByYAML reproduces excludeKeysByYaml (src/util.js:872).
func pinnedExcludeKeysByYAML(target *orderedNodeJSON, value orderedNodeJSON) {
	text, isString := value.stringValue()
	if !isString || text == "" {
		return
	}
	root, err := decodePinnedYAML(text)
	if err != nil {
		return
	}
	switch {
	case root.Kind == yaml.SequenceNode:
		for _, item := range root.Content {
			resolved := resolvePinnedYAMLAlias(item)
			key, keyErr := pinnedYAMLStringValue(resolved)
			if keyErr != nil {
				continue
			}
			target.deleteMember(key)
		}
	case root.Kind == yaml.MappingNode:
		for index := 0; index+1 < len(root.Content); index += 2 {
			target.deleteMember(root.Content[index].Value)
		}
	case root.Kind == yaml.ScalarNode && root.Tag == "!!str":
		target.deleteMember(root.Value)
	}
}

func decodePinnedYAML(text string) (*yaml.Node, error) {
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(text), &document); err != nil {
		return nil, err
	}
	if len(document.Content) == 0 {
		return nil, errors.New("empty YAML document")
	}
	return document.Content[0], nil
}

func resolvePinnedYAMLAlias(node *yaml.Node) *yaml.Node {
	if node.Kind == yaml.AliasNode && node.Alias != nil {
		return node.Alias
	}
	return node
}

// pinnedYAMLAssignments is the list of members `Object.assign` would apply for
// a parsed YAML document.
func pinnedYAMLAssignments(root *yaml.Node) []orderedNodeJSONEntry {
	root = resolvePinnedYAMLAlias(root)
	switch root.Kind {
	case yaml.MappingNode:
		return pinnedYAMLMappingEntries(root)
	case yaml.SequenceNode:
		entries := make([]orderedNodeJSONEntry, 0)
		for _, item := range root.Content {
			resolved := resolvePinnedYAMLAlias(item)
			if resolved.Kind != yaml.MappingNode {
				continue
			}
			entries = append(entries, pinnedYAMLMappingEntries(resolved)...)
		}
		return entries
	default:
		return nil
	}
}

func pinnedYAMLMappingEntries(node *yaml.Node) []orderedNodeJSONEntry {
	entries := make([]orderedNodeJSONEntry, 0, len(node.Content)/2)
	for index := 0; index+1 < len(node.Content); index += 2 {
		value, ok := pinnedYAMLValue(node.Content[index+1])
		if !ok {
			continue
		}
		entries = append(entries, orderedNodeJSONEntry{key: node.Content[index].Value, value: value})
	}
	return entries
}

func pinnedYAMLValue(node *yaml.Node) (orderedNodeJSON, bool) {
	node = resolvePinnedYAMLAlias(node)
	switch node.Kind {
	case yaml.MappingNode:
		object := nodeObject()
		for _, entry := range pinnedYAMLMappingEntries(node) {
			object.setMember(entry.key, entry.value)
		}
		return object, true
	case yaml.SequenceNode:
		array := nodeArray()
		for _, item := range node.Content {
			child, ok := pinnedYAMLValue(item)
			if !ok {
				return orderedNodeJSON{}, false
			}
			array.array = append(array.array, child)
		}
		return array, true
	case yaml.ScalarNode:
		switch node.Tag {
		case "!!null":
			return orderedNodeJSON{kind: 'n'}, true
		case "!!bool":
			return nodeBool(strings.EqualFold(node.Value, "true")), true
		case "!!int", "!!float":
			number, err := strconv.ParseFloat(strings.ReplaceAll(node.Value, "_", ""), 64)
			if err != nil {
				return orderedNodeJSON{}, false
			}
			return nodeNumber(number), true
		default:
			return nodeString(node.Value), true
		}
	}
	return orderedNodeJSON{}, false
}

func pinnedYAMLStringValue(node *yaml.Node) (string, error) {
	value, ok := pinnedYAMLValue(node)
	if !ok {
		return "", errors.New("unsupported YAML value")
	}
	return pinnedJSStringValue(value)
}

// pinnedFlattenSchema reproduces flattenSchema (src/util.js:1459) for the
// sources this route implements. The Google-only keyword filtering does not
// apply to openai or custom.
func pinnedFlattenSchema(schema orderedNodeJSON) orderedNodeJSON {
	if !schema.truthy() || (schema.kind != 'o' && schema.kind != 'a') {
		return schema
	}
	copied := pinnedStructuredClone(schema)
	definitions := nodeObject()
	if copied.kind == 'o' {
		if defs, exists := copied.member("$defs"); exists && defs.kind == 'o' {
			definitions = defs
		}
		copied.deleteMember("$defs")
	}
	flattened := pinnedFlattenResolve(copied, definitions, nil)
	if flattened.kind == 'o' {
		flattened.deleteMember("$schema")
	}
	return flattened
}

func pinnedFlattenResolve(value orderedNodeJSON, definitions orderedNodeJSON, parents []string) orderedNodeJSON {
	switch value.kind {
	case 'a':
		array := nodeArray()
		for _, item := range value.array {
			array.array = append(array.array, pinnedFlattenResolve(item, definitions, parents))
		}
		return array
	case 'o':
		if reference, exists := value.member("$ref"); exists {
			if text, isString := reference.stringValue(); isString && strings.HasPrefix(text, "#/$defs/") {
				parts := strings.Split(text, "/")
				definitionName := parts[len(parts)-1]
				for _, parent := range parents {
					if parent == definitionName {
						// Prevent infinite recursion, exactly as the pinned
						// `parents.includes(defName)` guard does.
						return nodeObject()
					}
				}
				if definition, found := definitions.member(definitionName); found {
					next := append(append([]string(nil), parents...), definitionName)
					return pinnedFlattenResolve(pinnedStructuredClone(definition), definitions, next)
				}
				return nodeObject()
			}
		}
		result := nodeObject()
		for _, entry := range value.object {
			result.setMember(entry.key, pinnedFlattenResolve(entry.value, definitions, parents))
		}
		return result
	default:
		return value
	}
}

// pinnedStructuredClone is structuredClone for decoded JSON.
func pinnedStructuredClone(value orderedNodeJSON) orderedNodeJSON {
	switch value.kind {
	case 'o':
		object := nodeObject()
		for _, entry := range value.object {
			object.setMember(entry.key, pinnedStructuredClone(entry.value))
		}
		return object
	case 'a':
		array := nodeArray()
		for _, item := range value.array {
			array.array = append(array.array, pinnedStructuredClone(item))
		}
		return array
	default:
		return value
	}
}
