package startup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/upstream"
)

type orderedJSONMember struct {
	key   string
	value any
}

type orderedJSONObject struct {
	members []orderedJSONMember
}

type orderedJSONArray []any

type nodeJSONNumber float64
type nodeJSONString string

type migratedSystemPrompt struct {
	name    any
	content any
}

// MigrateSystemPrompts converts legacy system_prompt fields in user instruct
// templates, keeps originals in the upstream backup layout, and writes the
// .migrated marker. Per-user failures are returned while later users continue,
// matching the pinned startup loop's error boundary.
func MigrateSystemPrompts(dataRoot string, directoriesList []UserDirectories) ([]error, error) {
	if len(directoriesList) == 0 {
		return nil, nil
	}
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve data root: %w", err)
	}
	lockRoot, err := canonicalPath(absoluteRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve system-prompt migration root: %w", err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return nil, err
	}
	defer lock.Close()

	defaultContents := getDefaultSystemPromptContents()
	var migrationErrors []error
	for _, directories := range directoriesList {
		if err := migrateUserSystemPrompts(directories, defaultContents); err != nil {
			migrationErrors = append(migrationErrors, err)
		}
	}
	return migrationErrors, nil
}

func migrateUserSystemPrompts(directories UserDirectories, defaultContents []any) error {
	root := directories["root"]
	instructDirectory := directories["instruct"]
	systemPromptDirectory := directories["sysprompt"]
	backupDirectory := filepath.Join(directories["backups"], "_sysprompt")
	if root == "" || instructDirectory == "" || systemPromptDirectory == "" || directories["backups"] == "" {
		return errors.New("user directory set is missing root, instruct, sysprompt, or backups")
	}

	markerPath := filepath.Join(systemPromptDirectory, ".migrated")
	if _, err := os.Stat(markerPath); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("inspect migration marker for %s: %w", root, err)
	}
	if err := os.MkdirAll(backupDirectory, 0o777); err != nil {
		return fmt.Errorf("create system-prompt backup directory for %s: %w", root, err)
	}

	entries, err := readDirectoryInNativeOrder(instructDirectory)
	if err != nil {
		return fmt.Errorf("read instruct directory for %s: %w", root, err)
	}
	migrated := make([]migratedSystemPrompt, 0)
	for _, entry := range entries {
		name := entry.Name()
		if filepath.Ext(name) != ".json" {
			continue
		}
		instructPath := filepath.Join(instructDirectory, name)
		existingPromptPath := filepath.Join(systemPromptDirectory, name)
		if _, err := os.Stat(existingPromptPath); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("inspect system-prompt target %s: %w", existingPromptPath, err)
		}

		original, err := os.ReadFile(instructPath)
		if err != nil {
			return fmt.Errorf("read instruct template %s: %w", instructPath, err)
		}
		instructData, err := decodeOrderedJSONObject(original)
		if err != nil {
			return fmt.Errorf("parse instruct template %s: %w", instructPath, err)
		}
		promptContent, hasContent := instructData.get("system_prompt")
		promptName, hasName := instructData.get("name")
		if !hasContent || !hasName {
			continue
		}

		backupName := nodeString(promptName) + ".json"
		backupPath := filepath.Join(backupDirectory, backupName)
		if err := ensureContained(backupDirectory, backupPath); err != nil {
			return fmt.Errorf("unsafe system-prompt backup name in %s: %w", instructPath, err)
		}
		if err := atomicReplace(backupPath, original); err != nil {
			return fmt.Errorf("backup instruct template %s: %w", instructPath, err)
		}
		instructData.delete("system_prompt")
		migratedTemplate, err := marshalNodeJSONIndent(instructData)
		if err != nil {
			return fmt.Errorf("serialize migrated instruct template %s: %w", instructPath, err)
		}
		if err := atomicReplace(instructPath, migratedTemplate); err != nil {
			return fmt.Errorf("write migrated instruct template %s: %w", instructPath, err)
		}
		migrated = append(migrated, migratedSystemPrompt{name: promptName, content: promptContent})
	}

	unique := make([]migratedSystemPrompt, 0, len(migrated))
	for _, prompt := range migrated {
		duplicate := false
		for _, existing := range unique {
			if sameJavaScriptValue(existing.content, prompt.content) {
				duplicate = true
				break
			}
		}
		if !duplicate {
			unique = append(unique, prompt)
		}
	}

	for _, prompt := range unique {
		isDefault := false
		for _, content := range defaultContents {
			if sameJavaScriptValue(content, prompt.content) {
				isDefault = true
				break
			}
		}
		if isDefault {
			continue
		}
		migratedName := "[Migrated] " + nodeString(prompt.name)
		promptPath := filepath.Join(systemPromptDirectory, migratedName+".json")
		if err := ensureContained(systemPromptDirectory, promptPath); err != nil {
			return fmt.Errorf("unsafe migrated system-prompt name: %w", err)
		}
		output := &orderedJSONObject{members: []orderedJSONMember{
			{key: "name", value: migratedName},
			{key: "content", value: prompt.content},
		}}
		body, err := marshalNodeJSONIndent(output)
		if err != nil {
			return fmt.Errorf("serialize migrated system prompt %s: %w", migratedName, err)
		}
		if err := atomicReplace(promptPath, body); err != nil {
			return fmt.Errorf("write migrated system prompt %s: %w", promptPath, err)
		}
	}

	if err := atomicReplace(markerPath, []byte{}); err != nil {
		return fmt.Errorf("write system-prompt migration marker for %s: %w", root, err)
	}
	return nil
}

func readDirectoryInNativeOrder(directory string) ([]fs.DirEntry, error) {
	file, err := os.Open(directory)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return file.ReadDir(-1)
}

func getDefaultSystemPromptContents() []any {
	items, err := loadPinnedContentIndex()
	if err != nil {
		return []any{}
	}
	contents := make([]any, 0)
	for _, item := range items {
		if item.Type != "sysprompt" {
			continue
		}
		body, err := upstream.Assets.ReadFile(path.Join(item.Folder, item.Filename))
		if err != nil {
			continue
		}
		prompt, err := decodeOrderedJSONObject(body)
		if err != nil {
			continue
		}
		if content, exists := prompt.get("content"); exists {
			contents = append(contents, content)
		}
	}
	return contents
}

func decodeOrderedJSONObject(body []byte) (*orderedJSONObject, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	value, err := decodeOrderedJSONValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, ok := value.(*orderedJSONObject); !ok {
		return nil, errors.New("JSON value is not an object")
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("unexpected trailing JSON value")
		}
		return nil, err
	}
	return value.(*orderedJSONObject), nil
}

func decodeOrderedJSONValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			object := &orderedJSONObject{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("JSON object key is not a string")
				}
				memberValue, err := decodeOrderedJSONValue(decoder)
				if err != nil {
					return nil, err
				}
				object.set(key, memberValue)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return object, nil
		case '[':
			array := make(orderedJSONArray, 0)
			for decoder.More() {
				item, err := decodeOrderedJSONValue(decoder)
				if err != nil {
					return nil, err
				}
				array = append(array, item)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return array, nil
		default:
			return nil, fmt.Errorf("unexpected JSON delimiter %q", value)
		}
	case json.Number:
		number, err := strconv.ParseFloat(string(value), 64)
		if err != nil {
			return nil, err
		}
		return nodeJSONNumber(number), nil
	case string:
		return nodeJSONString(value), nil
	default:
		return value, nil
	}
}

func (object *orderedJSONObject) get(key string) (any, bool) {
	for _, member := range object.members {
		if member.key == key {
			return member.value, true
		}
	}
	return nil, false
}

func (object *orderedJSONObject) set(key string, value any) {
	for index := range object.members {
		if object.members[index].key == key {
			object.members[index].value = value
			return
		}
	}
	object.members = append(object.members, orderedJSONMember{key: key, value: value})
}

func (object *orderedJSONObject) delete(key string) {
	for index, member := range object.members {
		if member.key == key {
			object.members = append(object.members[:index], object.members[index+1:]...)
			return
		}
	}
}

func (object *orderedJSONObject) MarshalJSON() ([]byte, error) {
	members := javascriptOrderedMembers(object.members)
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, member := range members {
		if index > 0 {
			buffer.WriteByte(',')
		}
		key, err := marshalNodeJSONString(member.key)
		if err != nil {
			return nil, err
		}
		value, err := marshalNodeJSONCompact(member.value)
		if err != nil {
			return nil, err
		}
		buffer.Write(key)
		buffer.WriteByte(':')
		buffer.Write(value)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

func (number nodeJSONNumber) MarshalJSON() ([]byte, error) {
	return []byte(javascriptNumberString(float64(number))), nil
}

func javascriptOrderedMembers(input []orderedJSONMember) []orderedJSONMember {
	integerKeys := make([]struct {
		index int
		value uint64
	}, 0)
	nonIntegerKeys := make([]orderedJSONMember, 0, len(input))
	for index, member := range input {
		value, err := strconv.ParseUint(member.key, 10, 32)
		if err == nil && value != math.MaxUint32 && strconv.FormatUint(value, 10) == member.key {
			integerKeys = append(integerKeys, struct {
				index int
				value uint64
			}{index: index, value: value})
			continue
		}
		nonIntegerKeys = append(nonIntegerKeys, member)
	}
	sort.Slice(integerKeys, func(left, right int) bool { return integerKeys[left].value < integerKeys[right].value })
	result := make([]orderedJSONMember, 0, len(input))
	for _, key := range integerKeys {
		result = append(result, input[key.index])
	}
	return append(result, nonIntegerKeys...)
}

func marshalNodeJSONCompact(value any) ([]byte, error) {
	switch typed := value.(type) {
	case nil:
		return []byte("null"), nil
	case bool:
		return []byte(strconv.FormatBool(typed)), nil
	case string:
		return marshalNodeJSONString(typed)
	case nodeJSONString:
		return marshalNodeJSONString(string(typed))
	case nodeJSONNumber:
		return []byte(javascriptNumberString(float64(typed))), nil
	case *orderedJSONObject:
		return typed.MarshalJSON()
	case orderedJSONArray:
		var buffer bytes.Buffer
		buffer.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				buffer.WriteByte(',')
			}
			encoded, err := marshalNodeJSONCompact(item)
			if err != nil {
				return nil, err
			}
			buffer.Write(encoded)
		}
		buffer.WriteByte(']')
		return buffer.Bytes(), nil
	default:
		return nil, fmt.Errorf("unsupported JSON value type %T", value)
	}
}

func marshalNodeJSONString(value string) ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"', '\\':
			buffer.WriteByte('\\')
			buffer.WriteRune(character)
		case '\b':
			buffer.WriteString("\\b")
		case '\f':
			buffer.WriteString("\\f")
		case '\n':
			buffer.WriteString("\\n")
		case '\r':
			buffer.WriteString("\\r")
		case '\t':
			buffer.WriteString("\\t")
		default:
			if character < 0x20 {
				buffer.WriteString(fmt.Sprintf("\\u%04x", character))
			} else {
				buffer.WriteRune(character)
			}
		}
	}
	buffer.WriteByte('"')
	return buffer.Bytes(), nil
}

func marshalNodeJSONIndent(value any) ([]byte, error) {
	compact, err := marshalNodeJSONCompact(value)
	if err != nil {
		return nil, err
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, compact, "", "    "); err != nil {
		return nil, err
	}
	return pretty.Bytes(), nil
}

func javascriptNumberString(number float64) string {
	if number == 0 {
		return "0"
	}
	absolute := math.Abs(number)
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.FormatFloat(number, 'f', -1, 64)
	}
	formatted := strconv.FormatFloat(number, 'e', -1, 64)
	parts := strings.SplitN(formatted, "e", 2)
	exponent, _ := strconv.Atoi(parts[1])
	sign := ""
	if exponent >= 0 {
		sign = "+"
	}
	return parts[0] + "e" + sign + strconv.Itoa(exponent)
}

func nodeString(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case string:
		return typed
	case nodeJSONString:
		return string(typed)
	case bool:
		return strconv.FormatBool(typed)
	case nodeJSONNumber:
		return javascriptNumberString(float64(typed))
	case orderedJSONArray:
		parts := make([]string, len(typed))
		for index, item := range typed {
			if item != nil {
				parts[index] = nodeString(item)
			}
		}
		return strings.Join(parts, ",")
	case *orderedJSONObject:
		return "[object Object]"
	default:
		return fmt.Sprint(typed)
	}
}

func sameJavaScriptValue(left, right any) bool {
	switch leftValue := left.(type) {
	case nil:
		return right == nil
	case string:
		rightValue, ok := right.(string)
		if ok {
			return leftValue == rightValue
		}
		rightNodeValue, ok := right.(nodeJSONString)
		return ok && leftValue == string(rightNodeValue)
	case nodeJSONString:
		rightValue, ok := right.(nodeJSONString)
		if ok {
			return leftValue == rightValue
		}
		rightStringValue, ok := right.(string)
		return ok && string(leftValue) == rightStringValue
	case bool:
		rightValue, ok := right.(bool)
		return ok && leftValue == rightValue
	case nodeJSONNumber:
		rightValue, ok := right.(nodeJSONNumber)
		return ok && float64(leftValue) == float64(rightValue)
	default:
		return false
	}
}
