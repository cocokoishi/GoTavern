// Package configinit implements the pinned config.yaml creation and migration
// behavior used before the SillyTavern server starts.
package configinit

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/lockacquire"
	"github.com/cocokoishi/gotavern/upstream"
	"github.com/gofrs/flock"
	"gopkg.in/yaml.v3"
)

// Result describes the persistent change made by Initialize.
type Result struct {
	Created bool
	Updated bool
}

type migrationKind uint8

const (
	keepValue migrationKind = iota
	invertBoolean
	booleanToImageFormat
	capacityToMegabytes
	removeValue
)

type migration struct {
	oldKey string
	newKey string
	kind   migrationKind
}

var migrations = []migration{
	{oldKey: "disableThumbnails", newKey: "thumbnails.enabled", kind: invertBoolean},
	{oldKey: "thumbnailsQuality", newKey: "thumbnails.quality", kind: keepValue},
	{oldKey: "avatarThumbnailsPng", newKey: "thumbnails.format", kind: booleanToImageFormat},
	{oldKey: "disableChatBackup", newKey: "backups.chat.enabled", kind: invertBoolean},
	{oldKey: "numberOfBackups", newKey: "backups.common.numberOfBackups", kind: keepValue},
	{oldKey: "maxTotalChatBackups", newKey: "backups.chat.maxTotalBackups", kind: keepValue},
	{oldKey: "chatBackupThrottleInterval", newKey: "backups.chat.throttleInterval", kind: keepValue},
	{oldKey: "enableExtensions", newKey: "extensions.enabled", kind: keepValue},
	{oldKey: "enableExtensionsAutoUpdate", newKey: "extensions.autoUpdate", kind: keepValue},
	{oldKey: "extras.disableAutoDownload", newKey: "extensions.models.autoDownload", kind: invertBoolean},
	{oldKey: "extras.classificationModel", newKey: "extensions.models.classification", kind: keepValue},
	{oldKey: "extras.captioningModel", newKey: "extensions.models.captioning", kind: keepValue},
	{oldKey: "extras.embeddingModel", newKey: "extensions.models.embedding", kind: keepValue},
	{oldKey: "extras.speechToTextModel", newKey: "extensions.models.speechToText", kind: keepValue},
	{oldKey: "extras.textToSpeechModel", newKey: "extensions.models.textToSpeech", kind: keepValue},
	{oldKey: "minLogLevel", newKey: "logging.minLogLevel", kind: keepValue},
	{oldKey: "cardsCacheCapacity", newKey: "performance.memoryCacheCapacity", kind: capacityToMegabytes},
	{oldKey: "cookieSecret", kind: removeValue},
	{oldKey: "autorun", newKey: "browserLaunch.enabled", kind: keepValue},
	{oldKey: "autorunHostname", newKey: "browserLaunch.hostname", kind: keepValue},
	{oldKey: "autorunPortOverride", newKey: "browserLaunch.port", kind: keepValue},
	{oldKey: "avoidLocalhost", newKey: "browserLaunch.avoidLocalhost", kind: keepValue},
	{oldKey: "extras.promptExpansionModel", kind: removeValue},
	{oldKey: "autheliaAuth", newKey: "sso.autheliaAuth", kind: keepValue},
	{oldKey: "authentikAuth", newKey: "sso.authentikAuth", kind: keepValue},
}

// Initialize creates a new config from the exact pinned Node serialization or
// migrates legacy fields and inserts defaults into an existing YAML mapping.
// Invalid YAML and write failures are returned without replacing the input.
func Initialize(configPath string) (Result, error) {
	canonicalPath, err := canonicalConfigPath(configPath)
	if err != nil {
		return Result{}, err
	}
	lock, err := acquireLock(canonicalPath)
	if err != nil {
		return Result{}, err
	}
	defer lock.Close()

	if _, err := os.Stat(canonicalPath); errors.Is(err, fs.ErrNotExist) {
		body, err := upstream.Assets.ReadFile("generated/default-config.yaml")
		if err != nil {
			return Result{}, fmt.Errorf("read pinned fresh config: %w", err)
		}
		if err := atomicWrite(canonicalPath, body, 0, false); err != nil {
			return Result{}, fmt.Errorf("create config %s: %w", canonicalPath, err)
		}
		return Result{Created: true}, nil
	} else if err != nil {
		return Result{}, fmt.Errorf("stat config %s: %w", canonicalPath, err)
	}

	input, err := os.ReadFile(canonicalPath)
	if err != nil {
		return Result{}, fmt.Errorf("read config %s: %w", canonicalPath, err)
	}
	config, err := parseMapping(input)
	if err != nil {
		return Result{}, fmt.Errorf("parse config %s: %w", canonicalPath, err)
	}
	defaultsBytes, err := upstream.Assets.ReadFile("generated/default-config.yaml")
	if err != nil {
		return Result{}, fmt.Errorf("read pinned config defaults: %w", err)
	}
	defaults, err := parseMapping(defaultsBytes)
	if err != nil {
		return Result{}, fmt.Errorf("parse pinned config defaults: %w", err)
	}

	if err := migrateEnvironment(); err != nil {
		return Result{}, err
	}
	// ONLY A LEGACY MIGRATION MAY REWRITE THE FILE. Defaults are merged INSIDE that branch, because the resulting
	// bytes are pinned's migrated output and the migration fixtures compare them exactly. A config that needs no
	// migration is left BYTE-IDENTICAL: its missing keys are supplied in memory at option-read time (every option
	// resolution in internal/commandline carries its own fallback -- 48 call sites, none without one), so the
	// rewrite only ever changed the user's file, never the behaviour.
	//
	// This is rule 27 and ARCHITECTURE 34.2. Before it, every boot of a stock tree rewrote config.yaml, which is
	// also how upstream's `extensions.autoUpdate: true` was materialised into configs whose user never chose it
	// (measured in internal/app/startup_p0b_test.go scenario (h)).
	changed := migrateConfig(config)
	if !changed {
		return Result{}, nil
	}
	mergeDefaults(config, defaults)

	output, err := stringifyConfig(config)
	if err != nil {
		return Result{}, fmt.Errorf("serialize config %s: %w", canonicalPath, err)
	}
	info, err := os.Stat(canonicalPath)
	if err != nil {
		return Result{}, fmt.Errorf("stat config %s before update: %w", canonicalPath, err)
	}
	if err := atomicWrite(canonicalPath, output, info.Mode().Perm(), true); err != nil {
		return Result{}, fmt.Errorf("update config %s: %w", canonicalPath, err)
	}
	return Result{Updated: true}, nil
}

func canonicalConfigPath(configPath string) (string, error) {
	absolute, err := filepath.Abs(configPath)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		return resolved, nil
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if err == nil {
		return filepath.Join(parent, filepath.Base(absolute)), nil
	}
	return filepath.Clean(absolute), nil
}

func acquireLock(configPath string) (*flock.Flock, error) {
	lockPath := lockPathFor(configPath)
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return nil, fmt.Errorf("create config lock directory: %w", err)
	}
	lock, acquireErr := lockacquire.Acquire(lockPath, "config")
	if acquireErr != nil {
		return nil, fmt.Errorf("lock config %s (%s): %w", configPath, lockPath, acquireErr)
	}
	return lock, nil
}

func atomicWrite(target string, body []byte, existingMode fs.FileMode, preserveMode bool) error {
	directory := filepath.Dir(target)
	var temporary *os.File
	for attempt := 0; attempt < 8; attempt++ {
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			return err
		}
		name := ".gotavern-config-" + hex.EncodeToString(token) + ".tmp"
		file, err := os.OpenFile(filepath.Join(directory, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return err
		}
		temporary = file
		break
	}
	if temporary == nil {
		return errors.New("could not allocate a unique config temporary file")
	}
	tempName := temporary.Name()
	defer os.Remove(tempName)

	if preserveMode {
		if err := temporary.Chmod(existingMode); err != nil {
			_ = temporary.Close()
			return err
		}
	}
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempName, target); err != nil {
		return err
	}
	if dir, err := os.Open(directory); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func parseMapping(input []byte) (*yaml.Node, error) {
	var document yaml.Node
	if err := yaml.Unmarshal(input, &document); err != nil {
		return nil, err
	}
	if len(document.Content) == 0 || document.Content[0].Kind == 0 || document.Content[0].Tag == "!!null" {
		document.Content = []*yaml.Node{mappingNode()}
	}
	root := document.Content[0]
	if root.Kind != yaml.MappingNode {
		return nil, errors.New("configuration root must be a YAML mapping")
	}
	return &document, nil
}

func mappingNode() *yaml.Node {
	return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
}

func scalarString(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}

func mappingValue(mapping *yaml.Node, key string) (int, bool) {
	if mapping == nil || mapping.Kind != yaml.MappingNode {
		return 0, false
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		keyNode := mapping.Content[i]
		if keyNode.Kind == yaml.ScalarNode && keyNode.Value == key {
			return i + 1, true
		}
	}
	return 0, false
}

func getPath(root *yaml.Node, dotted string) (*yaml.Node, bool) {
	parts := strings.Split(dotted, ".")
	current := root
	for _, part := range parts {
		if current.Kind == yaml.DocumentNode && len(current.Content) != 0 {
			current = current.Content[0]
		}
		index, found := mappingValue(current, part)
		if !found {
			return nil, false
		}
		current = current.Content[index]
	}
	return current, true
}

func setPath(root *yaml.Node, dotted string, value *yaml.Node) {
	parts := strings.Split(dotted, ".")
	current := root.Content[0]
	for _, part := range parts[:len(parts)-1] {
		index, found := mappingValue(current, part)
		if !found {
			current.Content = append(current.Content, scalarString(part), mappingNode())
			current = current.Content[len(current.Content)-1]
			continue
		}
		child := current.Content[index]
		if child.Kind != yaml.MappingNode {
			child = mappingNode()
			current.Content[index] = child
		}
		current = child
	}
	last := parts[len(parts)-1]
	if index, found := mappingValue(current, last); found {
		current.Content[index] = cleanClone(value, make(map[*yaml.Node]*yaml.Node))
		return
	}
	current.Content = append(current.Content, scalarString(last), cleanClone(value, make(map[*yaml.Node]*yaml.Node)))
}

func unsetPath(root *yaml.Node, dotted string) bool {
	parts := strings.Split(dotted, ".")
	current := root.Content[0]
	parents := make([]*yaml.Node, 0, len(parts))
	indices := make([]int, 0, len(parts))
	for _, part := range parts {
		index, found := mappingValue(current, part)
		if !found {
			return false
		}
		parents = append(parents, current)
		indices = append(indices, index-1)
		current = current.Content[index]
	}
	parent := parents[len(parents)-1]
	keyIndex := indices[len(indices)-1]
	parent.Content = append(parent.Content[:keyIndex], parent.Content[keyIndex+2:]...)
	return true
}

func migrateConfig(document *yaml.Node) bool {
	changed := false
	for _, item := range migrations {
		value, exists := getPath(document, item.oldKey)
		if !exists {
			continue
		}
		if item.kind == removeValue {
			changed = unsetPath(document, item.oldKey) || changed
			continue
		}
		migrated := cleanClone(value, make(map[*yaml.Node]*yaml.Node))
		switch item.kind {
		case invertBoolean:
			migrated = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(!jsTruthy(value))}
		case booleanToImageFormat:
			if jsTruthy(value) {
				migrated = scalarString("png")
			} else {
				migrated = scalarString("jpg")
			}
		case capacityToMegabytes:
			migrated = scalarString(jsString(value) + "mb")
		}
		setPath(document, item.newKey, migrated)
		_ = unsetPath(document, item.oldKey)
		changed = true
	}
	return changed
}

// operatorOwnedDefaults are keys GoTavern must never MATERIALISE into a user's config.yaml. Boot still inserts
// pinned's defaults (hard rule 13: default insertion is startup compatibility), but these three are the inputs of
// the extension/plugin auto-update decision, and writing them would turn "the user never said" into "the file
// says true" -- which is precisely how P0-C reached users, because upstream's own defaults say true
// (upstream/default/config.yaml:301, :396). They are reported and never acted on; the only input that can enable
// automatic updating is GoTavern's own key (ARCHITECTURE.md 34.3, AGENTS.md rule 26).
var operatorOwnedDefaults = []string{
	"extensions.autoUpdate",
	"extensions.autoUpdatePlugins",
	"enableServerPluginsAutoUpdate",
}

func mergeDefaults(destinationDocument, defaultsDocument *yaml.Node) bool {
	defaults := cleanClone(defaultsDocument, make(map[*yaml.Node]*yaml.Node))
	for _, key := range operatorOwnedDefaults {
		unsetPath(defaults, key)
	}
	return mergeNode(destinationDocument.Content[0], defaults.Content[0])
}

func mergeNode(destination, defaults *yaml.Node) bool {
	changed := false
	switch {
	case destination.Kind == yaml.MappingNode && defaults.Kind == yaml.MappingNode:
		for i := 0; i+1 < len(defaults.Content); i += 2 {
			defaultKey := defaults.Content[i]
			defaultValue := defaults.Content[i+1]
			if defaultKey.Kind != yaml.ScalarNode {
				continue
			}
			index, found := mappingValue(destination, defaultKey.Value)
			if !found {
				destination.Content = append(destination.Content, cleanClone(defaultKey, make(map[*yaml.Node]*yaml.Node)), cleanClone(defaultValue, make(map[*yaml.Node]*yaml.Node)))
				changed = true
				continue
			}
			if mergeNode(destination.Content[index], defaultValue) {
				changed = true
			}
		}
	case destination.Kind == yaml.SequenceNode && defaults.Kind == yaml.SequenceNode:
		for index, defaultValue := range defaults.Content {
			if index >= len(destination.Content) {
				destination.Content = append(destination.Content, cleanClone(defaultValue, make(map[*yaml.Node]*yaml.Node)))
				changed = true
				continue
			}
			if mergeNode(destination.Content[index], defaultValue) {
				changed = true
			}
		}
	}
	return changed
}

func cleanClone(node *yaml.Node, copies map[*yaml.Node]*yaml.Node) *yaml.Node {
	if node.Kind == yaml.AliasNode && node.Alias != nil {
		return cleanClone(node.Alias, copies)
	}
	if existing := copies[node]; existing != nil {
		return existing
	}
	clone := *node
	clone.Anchor = ""
	clone.Alias = nil
	clone.Style = 0
	clone.HeadComment = ""
	clone.LineComment = ""
	clone.FootComment = ""
	clone.Content = nil
	if clone.Kind == yaml.ScalarNode && clone.Tag == "!!str" && needsQuotedString(clone.Value) {
		clone.Style = yaml.DoubleQuotedStyle
	}
	copies[node] = &clone
	for _, child := range node.Content {
		clone.Content = append(clone.Content, cleanClone(child, copies))
	}
	return &clone
}

func needsQuotedString(value string) bool {
	if value == "" || strings.TrimSpace(value) != value {
		return true
	}
	switch strings.ToLower(value) {
	case "null", "~", "true", "false", ".nan", ".inf", "+.inf", "-.inf":
		return true
	}
	if _, err := strconv.ParseFloat(value, 64); err == nil {
		return true
	}
	if isPinnedYAMLInteger(value) {
		return true
	}
	first := value[0]
	switch first {
	case '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`':
		return true
	case '?', ':', '-':
		return len(value) == 1 || value[1] == ' ' || value[1] == '\t' || value[1] == '\n'
	}
	for index := 0; index+1 < len(value); index++ {
		if value[index] == ':' && (value[index+1] == ' ' || value[index+1] == '\t' || value[index+1] == '\n') {
			return true
		}
		if value[index] == ' ' && value[index+1] == '#' {
			return true
		}
	}
	return false
}

func isPinnedYAMLInteger(value string) bool {
	index := 0
	if value == "" {
		return false
	}
	if value[index] == '-' || value[index] == '+' {
		index++
	}
	if index >= len(value) {
		return false
	}
	if value[index] == '0' {
		if index+1 == len(value) {
			return true
		}
		switch value[index+1] {
		case 'b':
			return isPinnedRadixInteger(value[index+2:], 2)
		case 'o':
			return isPinnedRadixInteger(value[index+2:], 8)
		case 'x':
			return isPinnedRadixInteger(value[index+2:], 16)
		}
		index++
	}
	if value[index] == '_' {
		return false
	}
	hasDigits := false
	for ; index < len(value); index++ {
		character := value[index]
		if character == '_' {
			continue
		}
		if character < '0' || character > '9' {
			return false
		}
		hasDigits = true
	}
	return hasDigits && value[len(value)-1] != '_'
}

func isPinnedRadixInteger(value string, base int) bool {
	hasDigits := false
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character == '_' {
			continue
		}
		digit, valid := yamlRadixDigit(character)
		if !valid || digit >= base {
			return false
		}
		hasDigits = true
	}
	return hasDigits && value[len(value)-1] != '_'
}

func yamlRadixDigit(value byte) (int, bool) {
	switch {
	case value >= '0' && value <= '9':
		return int(value - '0'), true
	case value >= 'A' && value <= 'F':
		return int(value-'A') + 10, true
	case value >= 'a' && value <= 'f':
		return int(value-'a') + 10, true
	default:
		return 0, false
	}
}

func stringifyConfig(document *yaml.Node) ([]byte, error) {
	clean := cleanClone(document, make(map[*yaml.Node]*yaml.Node))
	var output bytes.Buffer
	encoder := yaml.NewEncoder(&output)
	encoder.SetIndent(2)
	if err := encoder.Encode(clean); err != nil {
		return nil, err
	}
	if err := encoder.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func migrateEnvironment() error {
	for _, item := range migrations {
		if item.kind == removeValue || item.newKey == "" {
			continue
		}
		oldName := environmentName(item.oldKey)
		newName := environmentName(item.newKey)
		oldValue, oldExists := os.LookupEnv(oldName)
		newValue, newExists := os.LookupEnv(newName)
		if !oldExists || oldValue == "" || (newExists && newValue != "") {
			continue
		}
		migrated := any(stringToBool(oldValue))
		switch item.kind {
		case invertBoolean:
			migrated = !jsTruthyValue(migrated)
		case booleanToImageFormat:
			if jsTruthyValue(migrated) {
				migrated = "png"
			} else {
				migrated = "jpg"
			}
		case capacityToMegabytes:
			migrated = jsStringValue(migrated) + "mb"
		case removeValue:
			migrated = nil
		}
		if err := os.Unsetenv(oldName); err != nil {
			return fmt.Errorf("remove legacy environment variable %s: %w", oldName, err)
		}
		if item.kind != removeValue {
			if err := os.Setenv(newName, fmt.Sprint(migrated)); err != nil {
				return fmt.Errorf("migrate environment variable %s: %w", oldName, err)
			}
		}
	}
	return nil
}

func environmentName(key string) string {
	return "SILLYTAVERN_" + strings.ToUpper(strings.ReplaceAll(key, ".", "_"))
}

func stringToBool(value string) any {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true":
		return true
	case "false":
		return false
	default:
		return value
	}
}

func jsTruthy(node *yaml.Node) bool {
	if node.Kind == yaml.MappingNode || node.Kind == yaml.SequenceNode {
		return true
	}
	var value any
	if err := node.Decode(&value); err != nil {
		return node.Value != ""
	}
	return jsTruthyValue(value)
}

func jsTruthyValue(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case int:
		return typed != 0
	case int64:
		return typed != 0
	case uint64:
		return typed != 0
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	default:
		return true
	}
}

func jsString(node *yaml.Node) string {
	var value any
	if err := node.Decode(&value); err != nil {
		return node.Value
	}
	return jsStringValue(value)
}

func jsStringValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(typed)
	case string:
		return typed
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case uint64:
		return strconv.FormatUint(typed, 10)
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64)
	case []any:
		parts := make([]string, len(typed))
		for index, item := range typed {
			if item != nil {
				parts[index] = jsStringValue(item)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return fmt.Sprint(typed)
	}
}
