package server

// Ordered JavaScript-object helpers used by the pinned characters domain.
//
// The pinned handlers build and mutate plain JavaScript objects and let
// JSON.stringify decide the resulting member order and undefined handling, so
// the character routes must preserve insertion order and distinguish a missing
// member from a member whose value is `undefined`. The orderedNodeJSON type
// already models JS member order; this file adds the `undefined` kind and the
// lodash-style accessors that the pinned character code uses.

import (
	"bytes"
	"io"
	"strconv"
	"strings"
	"unicode/utf16"
)

// nodeUndefinedKind marks a member whose JavaScript value is `undefined`.
// JSON.stringify omits such members from objects and writes `null` inside
// arrays, which is exactly how the pinned `readFromV2` backfill behaves: it
// assigns the missing extension default and then overwrites it with the
// undefined Spec V2 value.
const nodeUndefinedKind = 'u'

func nodeUndefined() orderedNodeJSON { return orderedNodeJSON{kind: nodeUndefinedKind} }

func nodeObject() orderedNodeJSON { return orderedNodeJSON{kind: 'o'} }

func nodeArray(values ...orderedNodeJSON) orderedNodeJSON {
	return orderedNodeJSON{kind: 'a', array: values}
}

func nodeString(value string) orderedNodeJSON {
	return orderedNodeJSON{kind: 's', scalar: value}
}

func nodeBool(value bool) orderedNodeJSON {
	return orderedNodeJSON{kind: 'b', scalar: value}
}

func nodeNumber(value float64) orderedNodeJSON {
	return orderedNodeJSON{kind: 'v', scalar: value}
}

func (value orderedNodeJSON) isUndefined() bool { return value.kind == nodeUndefinedKind }
func (value orderedNodeJSON) isNull() bool      { return value.kind == 'n' }
func (value orderedNodeJSON) isString() bool    { return value.kind == 's' }

// isPlainObject mirrors lodash's isPlainObject for JSON-decoded values: objects
// count, arrays and every scalar do not.
func (value orderedNodeJSON) isPlainObject() bool { return value.kind == 'o' }

func (value orderedNodeJSON) stringValue() (string, bool) {
	if value.kind != 's' {
		return "", false
	}
	text, ok := value.scalar.(string)
	return text, ok
}

// nodeGet resolves a lodash `_.get` path. The second result reports whether the
// path resolved at all; both a missing path and a resolved `undefined` member
// yield the undefined value, which is what `_.get`'s default applies to.
func nodeGet(root orderedNodeJSON, path ...string) orderedNodeJSON {
	current := root
	for _, key := range path {
		if current.kind != 'o' {
			return nodeUndefined()
		}
		member, exists := current.member(key)
		if !exists {
			return nodeUndefined()
		}
		current = member
	}
	return current
}

// nodeGetString resolves a path and falls back to the supplied default when the
// path does not resolve, matching `_.get(object, path, default)`.
func nodeGetString(root orderedNodeJSON, fallback string, path ...string) orderedNodeJSON {
	value := nodeGet(root, path...)
	if value.isUndefined() {
		return nodeString(fallback)
	}
	return value
}

func nodeGetBool(root orderedNodeJSON, fallback bool, path ...string) orderedNodeJSON {
	value := nodeGet(root, path...)
	if value.isUndefined() {
		return nodeBool(fallback)
	}
	return value
}

func nodeGetArray(root orderedNodeJSON, path ...string) orderedNodeJSON {
	value := nodeGet(root, path...)
	if value.isUndefined() {
		return nodeArray()
	}
	return value
}

// nodeSet writes a lodash `_.set` path, creating intermediate plain objects.
func nodeSet(root *orderedNodeJSON, path []string, value orderedNodeJSON) {
	if root.kind != 'o' || len(path) == 0 {
		return
	}
	key := path[0]
	if len(path) == 1 {
		root.setMember(key, value)
		return
	}
	for index := range root.object {
		if root.object[index].key != key {
			continue
		}
		if root.object[index].value.kind != 'o' {
			root.object[index].value = nodeObject()
		}
		nodeSet(&root.object[index].value, path[1:], value)
		return
	}
	child := nodeObject()
	nodeSet(&child, path[1:], value)
	root.setMember(key, child)
}

// nodeUnset removes a lodash `_.unset` path, reporting whether a member existed.
func nodeUnset(root *orderedNodeJSON, path ...string) bool {
	if root.kind != 'o' || len(path) == 0 {
		return false
	}
	if len(path) == 1 {
		return root.deleteMember(path[0])
	}
	for index := range root.object {
		if root.object[index].key == path[0] {
			return nodeUnset(&root.object[index].value, path[1:]...)
		}
	}
	return false
}

func nodeCloneDeep(value orderedNodeJSON) orderedNodeJSON {
	clone := value
	switch value.kind {
	case 'o':
		clone.object = make([]orderedNodeJSONEntry, len(value.object))
		for index, entry := range value.object {
			clone.object[index] = orderedNodeJSONEntry{key: entry.key, value: nodeCloneDeep(entry.value)}
		}
	case 'a':
		clone.array = make([]orderedNodeJSON, len(value.array))
		for index, item := range value.array {
			clone.array[index] = nodeCloneDeep(item)
		}
	}
	return clone
}

// characterString mirrors JavaScript's `String(value)` for JSON-decoded values,
// including the TypeError a plain object with a shadowed `toString` produces.
func characterString(value orderedNodeJSON) (string, error) {
	switch value.kind {
	case nodeUndefinedKind:
		return "undefined", nil
	case 'n':
		return "null", nil
	case 's':
		return value.scalar.(string), nil
	case 'h':
		return string(utf16.Decode([]uint16{value.scalar.(uint16)})), nil
	case 'b':
		return strconv.FormatBool(value.scalar.(bool)), nil
	case 'v':
		number := value.scalar.(float64)
		return javascriptNumberString(number), nil
	case 'a':
		parts := make([]string, len(value.array))
		for index, item := range value.array {
			part, err := characterString(item)
			if err != nil {
				return "", err
			}
			parts[index] = part
		}
		return strings.Join(parts, ","), nil
	case 'o':
		if _, exists := value.member("toString"); exists {
			return "", io.ErrUnexpectedEOF
		}
		return "[object Object]", nil
	default:
		return "", io.ErrUnexpectedEOF
	}
}

// marshalCharacterJSON mirrors JSON.stringify for the character domain: object
// members whose value is `undefined` are omitted, while array holes become null.
func marshalCharacterJSON(value orderedNodeJSON) ([]byte, error) {
	var body bytes.Buffer
	if err := writeCharacterJSON(&body, value); err != nil {
		return nil, err
	}
	return body.Bytes(), nil
}

func writeCharacterJSON(body *bytes.Buffer, value orderedNodeJSON) error {
	switch value.kind {
	case 'o':
		body.WriteByte('{')
		entries, _ := value.entries()
		written := 0
		for _, entry := range entries {
			if entry.value.kind == nodeUndefinedKind {
				continue
			}
			if written > 0 {
				body.WriteByte(',')
			}
			written++
			keyBytes, err := marshalNodeJSONString(entry.key)
			if err != nil {
				return err
			}
			body.Write(keyBytes)
			body.WriteByte(':')
			if err := writeCharacterJSON(body, entry.value); err != nil {
				return err
			}
		}
		body.WriteByte('}')
	case 'a':
		body.WriteByte('[')
		for index, item := range value.array {
			if index > 0 {
				body.WriteByte(',')
			}
			if item.kind == nodeUndefinedKind {
				body.WriteString("null")
				continue
			}
			if err := writeCharacterJSON(body, item); err != nil {
				return err
			}
		}
		body.WriteByte(']')
	case 's':
		encoded, err := marshalNodeJSONString(value.scalar.(string))
		if err != nil {
			return err
		}
		body.Write(encoded)
	case 'h':
		unit := value.scalar.(uint16)
		hex := strconv.FormatUint(uint64(unit), 16)
		body.WriteString(`"\u` + strings.Repeat("0", 4-len(hex)) + hex + `"`)
	case 'v':
		encoded, err := marshalECMAScriptNumber(value.scalar.(float64))
		if err != nil {
			return err
		}
		body.Write(encoded)
	case nodeUndefinedKind:
		body.WriteString("null")
	default:
		encoded, err := marshalNodeJSON(value.scalar)
		if err != nil {
			return err
		}
		body.Write(encoded)
	}
	return nil
}

// deepMerge mirrors the pinned util.js deepMerge: plain objects merge
// recursively, arrays and scalars replace, and `key in target` decides whether
// an existing member keeps its position.
func deepMerge(target, source orderedNodeJSON) orderedNodeJSON {
	output := nodeObject()
	if target.kind == 'o' {
		for _, entry := range target.object {
			output.setMember(entry.key, entry.value)
		}
	}
	if !target.isMergeObject() || !source.isMergeObject() {
		return output
	}
	for _, entry := range source.object {
		if entry.value.isMergeObject() {
			if _, exists := target.member(entry.key); !exists {
				output.setMember(entry.key, nodeCloneDeep(entry.value))
			} else {
				existing, _ := target.member(entry.key)
				output.setMember(entry.key, deepMerge(existing, entry.value))
			}
			continue
		}
		output.setMember(entry.key, nodeCloneDeep(entry.value))
	}
	return output
}

// isMergeObject mirrors util.js isObject: truthy, typeof object, not an array.
func (value orderedNodeJSON) isMergeObject() bool { return value.kind == 'o' }
