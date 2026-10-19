package server

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type settingsGetResponse struct {
	Settings                       string                     `json:"settings"`
	KoboldAISettings               []string                   `json:"koboldai_settings"`
	KoboldAISettingNames           []string                   `json:"koboldai_setting_names"`
	WorldNames                     []string                   `json:"world_names"`
	NovelAISettings                []string                   `json:"novelai_settings"`
	NovelAISettingNames            []string                   `json:"novelai_setting_names"`
	OpenAISettings                 []string                   `json:"openai_settings"`
	OpenAISettingNames             []string                   `json:"openai_setting_names"`
	TextGenerationWebUIPresets     []string                   `json:"textgenerationwebui_presets"`
	TextGenerationWebUIPresetNames []string                   `json:"textgenerationwebui_preset_names"`
	Themes                         []json.RawMessage          `json:"themes"`
	MovingUIPresets                []json.RawMessage          `json:"movingUIPresets"`
	QuickReplyPresets              []json.RawMessage          `json:"quickReplyPresets"`
	Instruct                       []json.RawMessage          `json:"instruct"`
	Context                        []json.RawMessage          `json:"context"`
	SysPrompt                      []json.RawMessage          `json:"sysprompt"`
	Reasoning                      []json.RawMessage          `json:"reasoning"`
	EnableExtensions               bool                       `json:"enable_extensions"`
	EnableExtensionsAutoUpdate     bool                       `json:"enable_extensions_auto_update"`
	EnableAccounts                 bool                       `json:"enable_accounts"`
	RequestCompression             requestCompressionResponse `json:"request_compression"`
}

type requestCompressionResponse struct {
	Enabled        bool `json:"enabled"`
	MinPayloadSize any  `json:"minPayloadSize"`
	MaxPayloadSize any  `json:"maxPayloadSize"`
	Timeout        any  `json:"timeout"`
}

func (runtime *accountRuntime) serveSettingsGet(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	settingsBytes, err := os.ReadFile(filepath.Join(directories["root"], "settings.json"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	response := settingsGetResponse{
		Settings:   string(bytes.ToValidUTF8(settingsBytes, []byte("\uFFFD"))),
		WorldNames: []string{},
		Themes:     []json.RawMessage{}, MovingUIPresets: []json.RawMessage{}, QuickReplyPresets: []json.RawMessage{},
		Instruct: []json.RawMessage{}, Context: []json.RawMessage{}, SysPrompt: []json.RawMessage{}, Reasoning: []json.RawMessage{},
		EnableExtensions:           optionBooleanDefault(runtime.options.ExtensionsEnabled, true),
		EnableExtensionsAutoUpdate: optionBooleanDefault(runtime.options.ExtensionsAutoUpdate, true),
		EnableAccounts:             runtime.options.AccountsEnabled,
		RequestCompression:         runtime.settingsRequestCompression(),
	}
	if response.KoboldAISettings, response.KoboldAISettingNames, err = readSettingsFiles(directories["koboldAI_Settings"], true); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if response.NovelAISettings, response.NovelAISettingNames, err = readSettingsFiles(directories["novelAI_Settings"], true); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if response.OpenAISettings, response.OpenAISettingNames, err = readSettingsFiles(directories["openAI_Settings"], true); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if response.TextGenerationWebUIPresets, response.TextGenerationWebUIPresetNames, err = readSettingsFiles(directories["textGen_Settings"], true); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if response.WorldNames, err = readWorldNames(directories["worlds"]); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	for _, item := range []struct {
		directory string
		target    *[]json.RawMessage
	}{
		{directories["themes"], &response.Themes},
		{directories["movingUI"], &response.MovingUIPresets},
		{directories["quickreplies"], &response.QuickReplyPresets},
		{directories["instruct"], &response.Instruct},
		{directories["context"], &response.Context},
		{directories["sysprompt"], &response.SysPrompt},
		{directories["reasoning"], &response.Reasoning},
	} {
		*item.target, err = readAndParseSettingsDirectory(item.directory)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	respondJSON(w, http.StatusOK, response)
}

func readSettingsFiles(directory string, removeExtension bool) ([]string, []string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, nil, err
	}
	names := make([]string, len(entries))
	for index, entry := range entries {
		names[index] = entry.Name()
	}
	sort.SliceStable(names, func(left, right int) bool {
		leftLower, rightLower := strings.ToLower(names[left]), strings.ToLower(names[right])
		if leftLower == rightLower {
			return names[left] < names[right]
		}
		return leftLower < rightLower
	})
	contents := make([]string, 0)
	fileNames := make([]string, 0)
	for _, name := range names {
		if filepath.Ext(name) != ".json" {
			continue
		}
		body, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil || !json.Valid(body) {
			continue
		}
		contents = append(contents, string(bytes.ToValidUTF8(body, []byte("\uFFFD"))))
		if removeExtension {
			fileNames = append(fileNames, strings.TrimSuffix(name, filepath.Ext(name)))
		} else {
			fileNames = append(fileNames, name)
		}
	}
	return contents, fileNames, nil
}

func readWorldNames(directory string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0)
	for _, entry := range entries {
		extension := filepath.Ext(entry.Name())
		if strings.EqualFold(extension, ".json") {
			names = append(names, strings.TrimSuffix(entry.Name(), extension))
		}
	}
	sort.SliceStable(names, func(left, right int) bool {
		leftLower, rightLower := strings.ToLower(names[left]), strings.ToLower(names[right])
		if leftLower == rightLower {
			return names[left] < names[right]
		}
		return leftLower < rightLower
	})
	return names, nil
}

func readAndParseSettingsDirectory(directory string) ([]json.RawMessage, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	values := make([]json.RawMessage, 0)
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		body, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil || !json.Valid(body) {
			continue
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, body); err != nil {
			continue
		}
		values = append(values, append(json.RawMessage(nil), compact.Bytes()...))
	}
	return values, nil
}

func (runtime *accountRuntime) settingsRequestCompression() requestCompressionResponse {
	compression := requestCompressionResponse{
		Enabled:        optionBooleanDefault(runtime.options.RequestCompressionEnabled, false),
		MinPayloadSize: parseSettingsBytes(runtime.options.RequestCompressionMin, "256kb"),
		MaxPayloadSize: parseSettingsBytes(runtime.options.RequestCompressionMax, "8mb"),
		Timeout:        3000,
	}
	if runtime.options.RequestCompressionTimeout != nil {
		compression.Timeout = jsonSafeNumber(runtime.options.RequestCompressionTimeout)
	}
	return compression
}

func optionBooleanDefault(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func parseSettingsBytes(value any, fallback string) any {
	if value == nil {
		value = fallback
	}
	if number, ok := value.(float64); ok {
		if math.IsNaN(number) {
			return 0
		}
		return jsonSafeNumber(number)
	}
	if number, ok := value.(int); ok {
		return number
	}
	text, ok := value.(string)
	if !ok {
		return 0
	}
	matched := settingsBytesWithUnitPattern.FindStringSubmatch(text)
	if len(matched) == 3 {
		number, err := strconv.ParseFloat(matched[1], 64)
		if err != nil || math.IsNaN(number) {
			return 0
		}
		powers := map[string]float64{"kb": 1, "mb": 2, "gb": 3, "tb": 4, "pb": 5}
		return jsonSafeNumber(math.Floor(number * math.Pow(1024, powers[strings.ToLower(matched[2])])))
	}
	integerPrefix := settingsIntegerPrefixPattern.FindString(text)
	if integerPrefix == "" {
		return 0
	}
	if number, err := strconv.ParseInt(strings.TrimSpace(integerPrefix), 10, 64); err == nil {
		return number
	}
	if number, err := strconv.ParseFloat(strings.TrimSpace(integerPrefix), 64); err == nil {
		return jsonSafeNumber(number)
	}
	return 0
}

func jsonSafeNumber(value any) any {
	switch number := value.(type) {
	case float64:
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return nil
		}
		return number
	case float32:
		if math.IsNaN(float64(number)) || math.IsInf(float64(number), 0) {
			return nil
		}
		return number
	default:
		return value
	}
}

var (
	settingsBytesWithUnitPattern = regexp.MustCompile(`^([+-]?\d+(?:\.\d+)?) *(kb|mb|gb|tb|pb)$`)
	settingsIntegerPrefixPattern = regexp.MustCompile(`^[\t\n\v\f\r ]*[+-]?\d+`)
)
