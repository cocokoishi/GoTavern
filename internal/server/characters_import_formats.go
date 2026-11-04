package server

// Pinned POST /api/characters/import — CharX (ZIP), BYAF (ZIP) and the RisuAI
// additions to the JSON/PNG card import path.
//
// WHY THIS FILE EXISTS. The pinned route dispatches on file_type: yaml/yml,
// json, png, charx and byaf (src/endpoints/characters.js:1560-1599). GoTavern
// reproduced the first three and answered the pinned catch branch for the last
// two, which is an honest error but not the capability. This file implements
// the two archives and the RisuAI sprite side effects, so the three named
// formats land their pinned state instead of a refusal.
//
// THE ORACLE IS THE PINNED SOURCE, and every branch below cites it:
//   - src/charx.js        CharXParser + persistCharXAssets
//   - src/byaf.js         ByafParser (manifest, character, scenarios, images,
//                         character card conversion, chat generation)
//   - src/endpoints/characters.js importFromCharX / importFromByaf /
//                         importFromJson / importFromPng
//   - src/endpoints/sprites.js importRisuSprites
//   - src/util.js         extractFileFromZipBuffer / extractFilesFromZipBuffer /
//                         normalizeZipEntryPath / getUniqueName /
//                         clientRelativePath / sanitizeSafeCharacterReplacements
//
// ZIP EXTRACTION SEMANTICS ARE PART OF THE CONTRACT. Pinned's
// extractFileFromZipBuffer matches by `entry.fileName.endsWith(name)` and skips
// entries under `__MACOSX`, while extractFilesFromZipBuffer matches a NORMALIZED
// exact path. Both behaviours are reproduced rather than "improved", because a
// card whose card.json lives in a subdirectory imports on pinned and must import
// here.

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"errors"
	"github.com/cocokoishi/gotavern/internal/userdata"
	"image"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	_ "image/gif"
	_ "image/jpeg"
	"image/png"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// ---------------------------------------------------------------------------------------------------------------
// ZIP, read the way the pinned helpers read it.
// ---------------------------------------------------------------------------------------------------------------

var zipLocalHeaderSignature = []byte{'P', 'K', 0x03, 0x04}

// findZipStart mirrors src/charx.js findZipStart: a self-extracting archive may
// carry a prefix, and pinned starts at the first local file header.
func findZipStart(data []byte) []byte {
	if index := bytes.Index(data, zipLocalHeaderSignature); index > 0 {
		return data[index:]
	}
	return data
}

// openPinnedZip opens the pinned archive view, including the SFX prefix rule.
func openPinnedZip(data []byte) (*zip.Reader, error) {
	start := findZipStart(data)
	if len(start) == 0 {
		return nil, errors.New("empty archive")
	}
	return zip.NewReader(bytes.NewReader(start), int64(len(start)))
}

// zipEntryMatchesSuffix mirrors `entry.fileName.endsWith(name) && !startsWith('__MACOSX')`.
func zipEntryMatchesSuffix(name, suffix string) bool {
	return !strings.HasPrefix(name, "__MACOSX") && strings.HasSuffix(name, suffix)
}

// extractFileFromZipBuffer mirrors src/util.js: the FIRST entry (central
// directory order) whose name ends with the given string, or nil.
func extractFileFromZipBuffer(reader *zip.Reader, suffix string) []byte {
	for _, file := range reader.File {
		if !zipEntryMatchesSuffix(file.Name, suffix) {
			continue
		}
		body, err := readZipEntry(file)
		if err != nil {
			continue
		}
		return body
	}
	return nil
}

// normalizeZipEntryPath mirrors src/util.js normalizeZipEntryPath.
func normalizeZipEntryPath(name string) (string, bool) {
	normalized := strings.TrimSpace(strings.ReplaceAll(name, "\\", "/"))
	if normalized == "" {
		return "", false
	}
	for strings.HasPrefix(normalized, "./") {
		normalized = strings.TrimPrefix(normalized, "./")
	}
	normalized = path.Clean(normalized)
	if normalized == "" || normalized == "." || strings.HasPrefix(normalized, "..") {
		return "", false
	}
	normalized = strings.TrimPrefix(normalized, "/")
	if normalized == "" {
		return "", false
	}
	return normalized, true
}

// extractFilesFromZipBuffer mirrors src/util.js: normalized exact-path matches.
func extractFilesFromZipBuffer(reader *zip.Reader, names []string) map[string][]byte {
	targets := make(map[string]bool, len(names))
	for _, name := range names {
		if normalized, ok := normalizeZipEntryPath(name); ok {
			targets[normalized] = true
		}
	}
	result := make(map[string][]byte, len(targets))
	if len(targets) == 0 {
		return result
	}
	for _, file := range reader.File {
		normalized, ok := normalizeZipEntryPath(file.Name)
		if !ok || !targets[normalized] {
			continue
		}
		body, err := readZipEntry(file)
		if err != nil {
			continue
		}
		result[normalized] = body
		delete(targets, normalized)
		if len(targets) == 0 {
			break
		}
	}
	return result
}

func readZipEntry(file *zip.File) ([]byte, error) {
	handle, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	return io.ReadAll(handle)
}

// ---------------------------------------------------------------------------------------------------------------
// File-name and path helpers (sanitize-filename with a replacement, getUniqueName,
// clientRelativePath, urlJoin).
// ---------------------------------------------------------------------------------------------------------------

// getUniqueName mirrors src/util.js getUniqueName with its default nameBuilder
// and maxTries 1000. Pinned passes startIndex 1 and its nameBuilder is
// `i === 0 ? base : `${base} (${i})“, so the FIRST candidate is already
// suffixed (" (1)"): the plain base name is never returned by this helper, which
// is why every BYAF background and alternate icon on a fresh tree carries " (1)".
func getUniqueName(baseName string, exists func(string) bool) string {
	for index := 1; index < 1000+1; index++ {
		candidate := baseName + " (" + itoa(index) + ")"
		if !exists(candidate) {
			return candidate
		}
	}
	return ""
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 8)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// clientRelativePath mirrors src/util.js: path relative to the user root with
// forward slashes. The pinned helper throws when the input is outside the root.
func clientRelativePath(root, inputPath string) (string, error) {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absoluteInput, err := filepath.Abs(inputPath)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(absoluteInput, absoluteRoot) {
		return "", errors.New("Input path does not start with the root directory")
	}
	relative := strings.ReplaceAll(strings.TrimPrefix(absoluteInput, absoluteRoot), string(filepath.Separator), "/")
	if !strings.HasPrefix(relative, "/") {
		relative = "/" + relative
	}
	return relative, nil
}

// jsPathDirname and jsPathJoin mirror the path.posix operations the pinned
// parsers use on ZIP-internal names.
func jsPathDirname(name string) string {
	return path.Dir(strings.ReplaceAll(name, "\\", "/"))
}

func jsPathJoin(parts ...string) string {
	cleaned := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			cleaned = append(cleaned, part)
		}
	}
	if len(cleaned) == 0 {
		return ""
	}
	return path.Clean(path.Join(cleaned...))
}

// reencodeImageToPNG reproduces the pinned writeCharacterData contract: the
// stored avatar is a PNG, whatever the source image format was. Pinned re-encodes
// through Jimp; the bytes are never compared for equality, only the decoded
// pixels (ARCHITECTURE.md boundary 3).
func reencodeImageToPNG(raw []byte) ([]byte, error) {
	if len(raw) >= 8 && bytes.Equal(raw[:8], []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}) {
		return raw, nil
	}
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	return encodeNRGBAImage(decoded)
}

// writeUserContentBytes writes one file atomically under the shared per-user
// content lock, creating its parent directory. Pinned uses writeFileAtomicSync
// for the same files; the lock is the repository's data-safety requirement
// (AGENTS.md hard rule 12).
func writeUserContentBytes(dataRoot, handle, relativePath string, body []byte) error {
	return startup.UpdateUserContentFile(dataRoot, handle, relativePath, func([]byte) ([]byte, error) {
		return body, nil
	})
}

// deleteExistingByBaseName mirrors the CharX sprite helper: any file in the
// directory whose base name (without the last extension) equals baseName is
// removed before the new file is written.
func deleteExistingByBaseName(directory, baseName string) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if strings.TrimSuffix(entry.Name(), path.Ext(entry.Name())) == baseName {
			_ = os.Remove(filepath.Join(directory, entry.Name()))
		}
	}
}

var errUnsupportedImage = errors.New("unsupported image")

// nowISO mirrors `new Date().toISOString()` for the fields pinned stamps.
func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// ---------------------------------------------------------------------------------------------------------------
// CharX (src/charx.js)
// ---------------------------------------------------------------------------------------------------------------

var charXImageExtensions = map[string]bool{
	"png": true, "jpg": true, "jpeg": true, "webp": true, "gif": true,
	"apng": true, "avif": true, "bmp": true, "jfif": true,
}

var charXSpriteTypes = map[string]bool{"emotion": true, "expression": true}
var charXBackgroundTypes = map[string]bool{"background": true}

type charXAsset struct {
	typeName        string
	name            string
	ext             string
	zipPath         string
	order           int
	storageCategory string
	baseName        string
}

// charXEmbeddedZipPath mirrors getEmbeddedZipPathFromUri. 'embeded://' is the
// pinned spelling (RisuAI exports use it), so it is not "fixed" here.
func charXEmbeddedZipPath(uri string) (string, bool) {
	if uri == "" {
		return "", false
	}
	trimmed := strings.TrimSpace(uri)
	if trimmed == "" {
		return "", false
	}
	lower := strings.ToLower(trimmed)
	for _, prefix := range []string{"embeded://", "embedded://", "__asset:"} {
		if strings.HasPrefix(lower, prefix) {
			return normalizeZipEntryPath(trimmed[len(prefix):])
		}
	}
	return "", false
}

func normalizeExtString(ext string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(ext)), ".")
}

// stripTrailingImageExtension mirrors charx.js: "image.png" with ext "png"
// becomes "image" so the stored name is not "image.png.png".
func stripTrailingImageExtension(name, expectedExt string) string {
	lower := strings.ToLower(name)
	if expectedExt != "" && strings.HasSuffix(lower, "."+expectedExt) {
		return name[:len(name)-(len(expectedExt)+1)]
	}
	for ext := range charXImageExtensions {
		if strings.HasSuffix(lower, "."+ext) {
			return name[:len(name)-(len(ext)+1)]
		}
	}
	return name
}

func deriveCharXAssetExtension(assetExt, zipPath string) string {
	if meta := normalizeExtString(assetExt); meta != "" {
		return meta
	}
	return normalizeExtString(strings.TrimPrefix(path.Ext(strings.ReplaceAll(zipPath, "\\", "/")), "."))
}

// collectCharXAssets mirrors CharXParser.collectCharXAssets: only assets whose
// uri is an embedded archive path count.
func collectCharXAssets(card orderedNodeJSON) []charXAsset {
	assets := nodeGet(card, "data", "assets")
	if assets.kind != 'a' {
		return nil
	}
	collected := make([]charXAsset, 0, len(assets.array))
	for index, item := range assets.array {
		if item.kind != 'o' {
			continue
		}
		uri, _ := nodeGet(item, "uri").stringValue()
		zipPath, ok := charXEmbeddedZipPath(uri)
		if !ok {
			continue
		}
		assetExt, _ := nodeGet(item, "ext").stringValue()
		typeName := ""
		if rawType, isString := nodeGet(item, "type").stringValue(); isString {
			typeName = strings.ToLower(rawType)
		}
		name, _ := nodeGet(item, "name").stringValue()
		collected = append(collected, charXAsset{
			typeName: typeName,
			name:     name,
			ext:      deriveCharXAssetExtension(assetExt, zipPath),
			zipPath:  zipPath,
			order:    index,
		})
	}
	return collected
}

// pickCharXIconAsset mirrors CharXParser.pickCharXIconAsset: the icon asset
// named "main" wins, otherwise the first icon.
func pickCharXIconAsset(assets []charXAsset) *charXAsset {
	var first *charXAsset
	for index := range assets {
		asset := &assets[index]
		if asset.typeName != "icon" || !charXImageExtensions[asset.ext] || asset.zipPath == "" {
			continue
		}
		if strings.ToLower(asset.name) == "main" {
			return asset
		}
		if first == nil {
			first = asset
		}
	}
	return first
}

// getCharXAssetBaseName mirrors CharXParser.getCharXAssetBaseName: lowercase,
// non-alphanumeric runs collapsed to the separator, then sanitize-filename.
func getCharXAssetBaseName(name, fallback string, useHyphens bool) string {
	cleaned := strings.TrimSpace(name)
	if cleaned == "" {
		return strings.ToLower(fallback)
	}
	separator := "_"
	if useHyphens {
		separator = "-"
	}
	var base strings.Builder
	lastSeparator := false
	for _, character := range strings.ToLower(cleaned) {
		alphanumeric := (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')
		if alphanumeric {
			base.WriteRune(character)
			lastSeparator = false
			continue
		}
		if !lastSeparator && base.Len() > 0 {
			base.WriteString(separator)
			lastSeparator = true
		}
	}
	result := strings.Trim(base.String(), separator)
	if result == "" {
		return strings.ToLower(fallback)
	}
	sanitized := startup.SanitizeUserFilename(result)
	if sanitized == "" {
		sanitized = fallback
	}
	return strings.ToLower(sanitized)
}

// mapCharXAssetsForStorage mirrors CharXParser.mapCharXAssetsForStorage.
func mapCharXAssetsForStorage(assets []charXAsset) []charXAsset {
	mapped := make([]charXAsset, 0, len(assets))
	for _, asset := range assets {
		if asset.zipPath == "" {
			continue
		}
		ext := strings.ToLower(asset.ext)
		if !charXImageExtensions[ext] {
			continue
		}
		if asset.typeName == "icon" || asset.typeName == "user_icon" {
			continue
		}
		category := "misc"
		switch {
		case charXSpriteTypes[asset.typeName]:
			category = "sprite"
		case charXBackgroundTypes[asset.typeName]:
			category = "background"
		}
		withoutExt := stripTrailingImageExtension(asset.name, ext)
		asset.ext = ext
		asset.storageCategory = category
		asset.baseName = getCharXAssetBaseName(withoutExt, category+"-"+itoa(asset.order), category == "sprite")
		mapped = append(mapped, asset)
	}
	return mapped
}

// persistCharXAssets mirrors src/charx.js persistCharXAssets, including the
// swallowed per-asset failures (pinned warns and continues).
func (runtime *accountRuntime) persistCharXAssets(account *storedAccount, directories map[string]string, characterFolder string, assets []charXAsset, buffers map[string][]byte) {
	for _, asset := range assets {
		body, ok := buffers[asset.zipPath]
		if !ok {
			continue
		}
		extension := asset.ext
		if extension == "" {
			extension = "png"
		}
		switch asset.storageCategory {
		case "sprite":
			directory := filepath.Join(directories["characters"], characterFolder)
			if err := os.MkdirAll(directory, 0o777); err != nil {
				continue
			}
			deleteExistingByBaseName(directory, asset.baseName)
			name := asset.baseName + "." + extension
			_ = writeUserContentBytes(runtime.options.DataRoot, account.string("handle"), filepath.ToSlash(filepath.Join("characters", characterFolder, name)), body)
		case "background":
			directory := filepath.Join(directories["characters"], characterFolder, "backgrounds")
			if err := os.MkdirAll(directory, 0o777); err != nil {
				continue
			}
			deleteExistingByBaseName(directory, asset.baseName)
			name := asset.baseName + "." + extension
			_ = writeUserContentBytes(runtime.options.DataRoot, account.string("handle"), filepath.ToSlash(filepath.Join("characters", characterFolder, "backgrounds", name)), body)
		case "misc":
			directory := filepath.Join(directories["userImages"], characterFolder)
			if err := os.MkdirAll(directory, 0o777); err != nil {
				continue
			}
			name := asset.baseName + "." + extension
			_ = writeUserContentBytes(runtime.options.DataRoot, account.string("handle"), filepath.ToSlash(filepath.Join("user", "images", characterFolder, name)), body)
		}
	}
}

// importFromCharX mirrors importFromCharX (src/endpoints/characters.js:765-801).
func (runtime *accountRuntime) importFromCharX(uploadPath, preservedFileName string, directories map[string]string, account *storedAccount) (string, bool) {
	raw, err := os.ReadFile(uploadPath)
	if err != nil {
		return "", true
	}
	removeStagedCharacterUpload(uploadPath)
	reader, err := openPinnedZip(raw)
	if err != nil {
		return "", true
	}
	cardBuffer := extractFileFromZipBuffer(reader, "card.json")
	if cardBuffer == nil {
		return "", true
	}
	card, err := decodeOrderedNodeJSON(cardBuffer)
	if err != nil || card.kind != 'o' {
		return "", true
	}
	if _, exists := card.member("spec"); !exists {
		return "", true
	}
	assets := collectCharXAssets(card)
	icon := pickCharXIconAsset(assets)
	auxiliary := mapCharXAssetsForStorage(assets)

	paths := make([]string, 0, len(auxiliary)+1)
	if icon != nil && icon.zipPath != "" {
		paths = append(paths, icon.zipPath)
	}
	for _, asset := range auxiliary {
		paths = append(paths, asset.zipPath)
	}
	buffers := extractFilesFromZipBuffer(reader, paths)

	avatar := defaultAvatarBytes()
	if icon != nil {
		if body, ok := buffers[icon.zipPath]; ok && len(body) > 0 {
			avatar = body
		}
	}

	dataName := nodeGet(card, "data", "name")
	if jsTruthy(dataName) {
		sanitized, err := sanitizeCharacterName(dataName)
		if err != nil {
			return "", true
		}
		nodeSet(&card, []string{"data", "name"}, nodeString(sanitized))
	}
	nameTarget := nodeGet(card, "name")
	if jsTruthy(nodeGet(card, "data", "name")) {
		nameTarget = nodeGet(card, "data", "name")
	}
	name, err := sanitizeCharacterName(nameTarget)
	if err != nil {
		return "", true
	}
	nodeSet(&card, []string{"name"}, nodeString(name))

	processed := readFromV2(card)
	unsetPrivateFields(&processed)
	nodeSet(&processed, []string{"create_date"}, nodeString(nowISO()))

	processedName, err := sanitizeCharacterName(nodeGet(processed, "name"))
	if err != nil {
		return "", true
	}
	fileName := preservedFileName
	if fileName == "" {
		fileName, err = getPngName(nodeString(processedName), directories)
		if err != nil {
			return "", true
		}
	}
	runtime.persistCharXAssets(account, directories, processedName, auxiliary, buffers)

	encodedAvatar, err := reencodeImageToPNG(avatar)
	if err != nil {
		return "", true
	}
	data, err := marshalCharacterJSON(processed)
	if err != nil {
		return "", true
	}
	if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), fileName, encodedAvatar, string(data)); err != nil {
		return "", true
	}
	return fileName, false
}

// image.Encode is routed through a helper so characters_write.go's encoder is
// the single PNG encoder for this package.
func encodeNRGBAImage(source image.Image) ([]byte, error) {
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// jsOr mirrors JavaScript's `a || b` for JSON values.
func jsOr(value, fallback orderedNodeJSON) orderedNodeJSON {
	if jsTruthy(value) {
		return value
	}
	return fallback
}

// jsNullish mirrors JavaScript's `a ?? b` for JSON values.
func jsNullish(value, fallback orderedNodeJSON) orderedNodeJSON {
	if value.isUndefined() || value.kind == 'n' {
		return fallback
	}
	return value
}

// jsNumberCoerce mirrors JavaScript's `Number(value)` for the JSON values the
// BYAF parser feeds into send_date. undefined (and an unparseable string)
// becomes NaN, which JSON.stringify writes as null.
func jsNumberCoerce(value orderedNodeJSON) orderedNodeJSON {
	switch value.kind {
	case 'v':
		return value
	case 'b':
		if truth, _ := value.scalar.(bool); truth {
			return nodeNumber(1)
		}
		return nodeNumber(0)
	case 'n':
		return nodeNumber(0)
	case 's':
		text, _ := value.scalar.(string)
		if text == "" {
			return nodeNumber(0)
		}
		number, ok := jsNumber(nodeString(text))
		if !ok {
			return orderedNodeJSON{kind: 'n'}
		}
		return nodeNumber(number)
	default:
		return orderedNodeJSON{kind: 'n'}
	}
}

// jsStringOrEmpty mirrors `String(value || ”)`, the coercion the BYAF parser
// applies through replaceMacros / the chat-header template.
func jsStringOrEmpty(value orderedNodeJSON) string {
	if !jsTruthy(value) {
		return ""
	}
	text, ok := jsStringOf(value)
	if !ok {
		return ""
	}
	return text
}

// byafReplaceMacros mirrors ByafParser.replaceMacros. The regexes are anchored
// per case so `#{user}:` is not double-substituted after the brace forms.
func byafReplaceMacros(text string) string {
	result := text
	result = replaceCaseInsensitive(result, "#{user}:", "{{user}}:", false)
	result = replaceCaseInsensitive(result, "#{character}:", "{{char}}:", false)
	result = replaceCaseInsensitive(result, "{character}", "{{char}}", true)
	result = replaceCaseInsensitive(result, "{user}", "{{user}}", true)
	return result
}

// replaceCaseInsensitive mirrors the /pattern/gi replacements above. The
// single-brace needles carry a negative lookahead for `}` in the pinned regexp.
func replaceCaseInsensitive(text, needle, replacement string, skipClosingBrace bool) string {
	lowerText := strings.ToLower(text)
	lowerNeedle := strings.ToLower(needle)
	var builder strings.Builder
	index := 0
	for {
		position := strings.Index(lowerText[index:], lowerNeedle)
		if position < 0 {
			builder.WriteString(text[index:])
			return builder.String()
		}
		position += index
		builder.WriteString(text[index:position])
		after := position + len(needle)
		if skipClosingBrace && after < len(text) && text[after] == '}' {
			builder.WriteString(text[position:after])
			index = after
			continue
		}
		builder.WriteString(replacement)
		index = after
	}
}

// byafFormatExampleMessages mirrors ByafParser.formatExampleMessages.
func byafFormatExampleMessages(examples orderedNodeJSON) string {
	if examples.kind != 'a' {
		return ""
	}
	formatted := ""
	for _, example := range examples.array {
		if example.kind != 'o' {
			continue
		}
		textValue := nodeGet(example, "text")
		if !jsTruthy(textValue) {
			continue
		}
		formatted += "<START>\n" + byafReplaceMacros(jsStringOrEmpty(textValue)) + "\n"
	}
	return strings.TrimSuffix(formatted, "\n")
}

// byafFormatAlternateGreetings mirrors ByafParser.formatAlternateGreetings:
// scenario 0 supplies first_mes, so only later scenarios become alternate
// greetings, deduplicated by their macro-replaced text.
func byafFormatAlternateGreetings(scenarios []orderedNodeJSON) []orderedNodeJSON {
	if len(scenarios) <= 1 {
		return []orderedNodeJSON{}
	}
	firstText := ""
	if firstMessages := nodeGet(scenarios[0], "firstMessages"); firstMessages.kind == 'a' && len(firstMessages.array) > 0 {
		if textValue, ok := nodeGet(firstMessages.array[0], "text").stringValue(); ok {
			firstText = textValue
		}
	}
	seen := make(map[string]bool)
	greetings := make([]orderedNodeJSON, 0, len(scenarios)-1)
	for _, scenario := range scenarios[1:] {
		firstMessages := nodeGet(scenario, "firstMessages")
		if firstMessages.kind != 'a' || len(firstMessages.array) == 0 {
			continue
		}
		textValue, ok := nodeGet(firstMessages.array[0], "text").stringValue()
		if !ok || textValue == "" || textValue == firstText {
			continue
		}
		macro := byafReplaceMacros(textValue)
		if seen[macro] {
			continue
		}
		seen[macro] = true
		greetings = append(greetings, nodeString(macro))
	}
	return greetings
}

// byafConvertCharacterBook mirrors ByafParser.convertCharacterBook.
func byafConvertCharacterBook(items orderedNodeJSON) (orderedNodeJSON, bool) {
	if items.kind != 'a' || len(items.array) == 0 {
		return orderedNodeJSON{}, false
	}
	book := nodeObject()
	entries := make([]orderedNodeJSON, 0, len(items.array))
	for index, item := range items.array {
		if item.kind != 'o' {
			continue
		}
		keys := make([]orderedNodeJSON, 0, 2)
		for _, key := range strings.Split(byafReplaceMacros(jsStringOrEmpty(nodeGet(item, "key"))), ",") {
			trimmed := strings.TrimSpace(key)
			if trimmed != "" {
				keys = append(keys, nodeString(trimmed))
			}
		}
		entry := nodeObject()
		entry.setMember("keys", nodeArray(keys...))
		entry.setMember("content", nodeString(byafReplaceMacros(jsStringOrEmpty(nodeGet(item, "value")))))
		entry.setMember("extensions", nodeObject())
		entry.setMember("enabled", nodeBool(true))
		entry.setMember("insertion_order", nodeNumber(float64(index)))
		entries = append(entries, entry)
	}
	book.setMember("entries", nodeArray(entries...))
	book.setMember("extensions", nodeObject())
	return book, true
}

// byafCharacterCard mirrors ByafParser.getCharacterCard, including the keys
// JSON.stringify drops because their value is `undefined` (character_book when
// the character has no lore, display_name when absent).
func byafCharacterCard(manifest, character orderedNodeJSON, scenarios []orderedNodeJSON) orderedNodeJSON {
	firstScenario := orderedNodeJSON{kind: nodeUndefinedKind}
	if len(scenarios) > 0 {
		firstScenario = scenarios[0]
	}

	name := jsOr(jsOr(nodeGet(character, "name"), nodeGet(character, "displayName")), nodeString(""))
	description := nodeString(byafReplaceMacros(jsStringOrEmpty(nodeGet(character, "persona"))))
	scenarioText := nodeString(byafReplaceMacros(jsStringOrEmpty(nodeGet(firstScenario, "narrative"))))
	firstMes := nodeString(byafReplaceMacros(byafFirstMessageText(firstScenario)))
	mesExample := nodeString(byafFormatExampleMessages(nodeGet(firstScenario, "exampleMessages")))
	creatorNotes := nodeString(jsStringOrEmpty(nodeGet(manifest, "author", "backyardURL")))
	systemPrompt := nodeString(byafReplaceMacros(jsStringOrEmpty(nodeGet(firstScenario, "formattingInstructions"))))
	creator := nodeString(jsStringOrEmpty(nodeGet(manifest, "author", "name")))
	tags := []orderedNodeJSON{}
	if jsTruthy(nodeGet(character, "isNSFW")) {
		tags = append(tags, nodeString("nsfw"))
	}
	data := nodeObject()
	data.setMember("name", name)
	data.setMember("description", description)
	data.setMember("personality", nodeString(""))
	data.setMember("scenario", scenarioText)
	data.setMember("first_mes", firstMes)
	data.setMember("mes_example", mesExample)
	data.setMember("creator_notes", creatorNotes)
	data.setMember("system_prompt", systemPrompt)
	data.setMember("post_history_instructions", nodeString(""))
	data.setMember("alternate_greetings", nodeArray(byafFormatAlternateGreetings(scenarios)...))
	if book, defined := byafConvertCharacterBook(nodeGet(character, "loreItems")); defined {
		data.setMember("character_book", book)
	}
	data.setMember("tags", nodeArray(tags...))
	data.setMember("creator", creator)
	data.setMember("character_version", nodeString(""))
	extensions := nodeObject()
	if displayName := nodeGet(character, "displayName"); jsTruthy(displayName) {
		extensions.setMember("display_name", displayName)
	}
	data.setMember("extensions", extensions)

	card := nodeObject()
	card.setMember("spec", nodeString("chara_card_v2"))
	card.setMember("spec_version", nodeString("2.0"))
	card.setMember("data", data)
	card.setMember("create_date", nodeString(nowISO()))
	return card
}

// byafFirstMessageText mirrors `scenario?.firstMessages?.[0]?.text` for the
// replaceMacros(String(value || ”)) call site.
func byafFirstMessageText(scenario orderedNodeJSON) string {
	firstMessages := nodeGet(scenario, "firstMessages")
	if firstMessages.kind != 'a' || len(firstMessages.array) == 0 {
		return ""
	}
	return jsStringOrEmpty(nodeGet(firstMessages.array[0], "text"))
}

type byafImage struct {
	filename string
	image    []byte
	label    string
}

type byafBackground struct {
	name  string
	data  []byte
	paths []string
}

// byafScenarios mirrors ByafParser.getScenariosFromManifest: missing/invalid
// scenario entries are skipped, and an empty result is one empty object.
func byafScenarios(reader *zip.Reader, manifest orderedNodeJSON) []orderedNodeJSON {
	paths := nodeGet(manifest, "scenarios")
	scenarios := make([]orderedNodeJSON, 0, 4)
	if paths.kind == 'a' {
		for _, pathValue := range paths.array {
			scenarioPath, ok := pathValue.stringValue()
			if !ok || scenarioPath == "" {
				continue
			}
			body := extractFileFromZipBuffer(reader, scenarioPath)
			if body == nil {
				continue
			}
			parsed, err := decodeOrderedNodeJSON(body)
			if err != nil {
				continue
			}
			scenarios = append(scenarios, parsed)
		}
	}
	if len(scenarios) == 0 {
		return []orderedNodeJSON{nodeObject()}
	}
	return scenarios
}

// byafCharacterImages mirrors ByafParser.getCharacterImages.
func byafCharacterImages(reader *zip.Reader, character orderedNodeJSON, characterPath string) []byafImage {
	images := nodeGet(character, "images")
	collected := make([]byafImage, 0, 4)
	if images.kind == 'a' {
		for _, imageValue := range images.array {
			imagePath, ok := nodeGet(imageValue, "path").stringValue()
			if !ok || imagePath == "" {
				continue
			}
			fullPath := jsPathJoin(jsPathDirname(characterPath), imagePath)
			body := extractFileFromZipBuffer(reader, fullPath)
			if body == nil {
				continue
			}
			label, _ := nodeGet(imageValue, "label").stringValue()
			collected = append(collected, byafImage{
				filename: path.Base(strings.ReplaceAll(imagePath, "\\", "/")),
				image:    body,
				label:    label,
			})
		}
	}
	if len(collected) == 0 {
		return []byafImage{{filename: "", image: defaultAvatarBytes(), label: ""}}
	}
	return collected
}

// byafChatBackgrounds mirrors ByafParser.getChatBackgrounds: one entry per
// distinct background image, with its scenario paths accumulated.
func byafChatBackgrounds(reader *zip.Reader, character orderedNodeJSON, scenarios []orderedNodeJSON) []byafBackground {
	backgrounds := make([]byafBackground, 0, 2)
	counter := 1
	for _, scenario := range scenarios {
		imagePath, ok := nodeGet(scenario, "backgroundImage").stringValue()
		if !ok || imagePath == "" {
			continue
		}
		body := extractFileFromZipBuffer(reader, imagePath)
		if body == nil {
			continue
		}
		existing := -1
		for index := range backgrounds {
			if bytes.Equal(backgrounds[index].data, body) {
				existing = index
				break
			}
		}
		if existing >= 0 {
			backgrounds[existing].paths = append(backgrounds[existing].paths, imagePath)
			continue
		}
		name := jsStringOrEmpty(nodeGet(character, "name"))
		if name == "" {
			name = "undefined"
		}
		backgrounds = append(backgrounds, byafBackground{
			name:  name + " bg " + itoa(counter),
			data:  body,
			paths: []string{imagePath},
		})
		counter++
	}
	return backgrounds
}

// byafChatFromScenario mirrors ByafParser.getChatFromScenario. It returns the
// JSONL text pinned writes, or an error for the same branches that throw there
// (a messages array whose AI entries have no outputs).
func byafChatFromScenario(scenario orderedNodeJSON, userName orderedNodeJSON, characterName string, backgrounds []byafBackground) (string, error) {
	messages := nodeGet(scenario, "messages")
	chatStartDate := orderedNodeJSON{kind: nodeUndefinedKind}
	if messages.kind == 'a' {
		if len(messages.array) == 0 {
			chatStartDate = nodeString(nowISO())
		} else {
			for _, message := range messages.array {
				if _, exists := message.member("createdAt"); exists {
					chatStartDate = nodeGet(message, "createdAt")
					break
				}
			}
		}
	}
	backgroundName := ""
	backgroundImage, _ := nodeGet(scenario, "backgroundImage").stringValue()
	for _, background := range backgrounds {
		found := false
		for _, candidate := range background.paths {
			if candidate == backgroundImage {
				found = true
				break
			}
		}
		if found {
			backgroundName = background.name
			break
		}
	}

	metadata := nodeObject()
	metadata.setMember("scenario", jsNullish(nodeGet(scenario, "narrative"), nodeString("")))
	metadata.setMember("mes_example", nodeString(byafFormatExampleMessages(nodeGet(scenario, "exampleMessages"))))
	metadata.setMember("system_prompt", nodeString(byafReplaceMacros(jsStringOrEmpty(nodeGet(scenario, "formattingInstructions")))))
	metadata.setMember("mes_examples_optional", jsNullish(nodeGet(scenario, "canDeleteExampleMessages"), nodeBool(false)))
	modelSettings := nodeObject()
	modelSettings.setMember("model", jsNullish(nodeGet(scenario, "model"), nodeString("")))
	modelSettings.setMember("temperature", jsNullish(nodeGet(scenario, "temperature"), nodeNumber(1.2)))
	modelSettings.setMember("top_k", jsNullish(nodeGet(scenario, "topK"), nodeNumber(40)))
	modelSettings.setMember("top_p", jsNullish(nodeGet(scenario, "topP"), nodeNumber(0.9)))
	modelSettings.setMember("min_p", jsNullish(nodeGet(scenario, "minP"), nodeNumber(0.1)))
	modelSettings.setMember("min_p_enabled", jsNullish(nodeGet(scenario, "minPEnabled"), nodeBool(true)))
	modelSettings.setMember("repeat_penalty", jsNullish(nodeGet(scenario, "repeatPenalty"), nodeNumber(1.05)))
	modelSettings.setMember("repeat_penalty_tokens", jsNullish(nodeGet(scenario, "repeatLastN"), nodeNumber(256)))
	modelSettings.setMember("by_prompt_template", jsNullish(nodeGet(scenario, "promptTemplate"), nodeString("general")))
	modelSettings.setMember("grammar", jsNullish(nodeGet(scenario, "grammar"), orderedNodeJSON{kind: 'n'}))
	metadata.setMember("byaf_model_settings", modelSettings)
	chatBackgrounds := make([]orderedNodeJSON, 0, 1)
	customBackground := ""
	if backgroundName != "" {
		chatBackgrounds = append(chatBackgrounds, nodeString(backgroundName))
		customBackground = `url("` + encodeURIString(backgroundName) + `")`
	}
	metadata.setMember("chat_backgrounds", nodeArray(chatBackgrounds...))
	metadata.setMember("custom_background", nodeString(customBackground))

	header := nodeObject()
	header.setMember("user_name", nodeString("unused"))
	header.setMember("character_name", nodeString("unused"))
	header.setMember("chat_metadata", metadata)
	lines := []orderedNodeJSON{header}

	firstMessages := nodeGet(scenario, "firstMessages")
	if firstMessages.kind == 'a' && len(firstMessages.array) > 0 {
		if firstText, ok := nodeGet(firstMessages.array[0], "text").stringValue(); ok && firstText != "" {
			message := nodeObject()
			message.setMember("name", nodeString(characterName))
			message.setMember("is_user", nodeBool(false))
			setSendDate(&message, chatStartDate)
			message.setMember("mes", nodeString(firstText))
			lines = append(lines, message)
		}
	}

	userMessages := make([]orderedNodeJSON, 0, 8)
	characterMessages := make([]orderedNodeJSON, 0, 8)
	if messages.kind == 'a' {
		for _, message := range messages.array {
			if kind, _ := nodeGet(message, "type").stringValue(); kind == "human" {
				userMessages = append(userMessages, message)
			} else {
				characterMessages = append(characterMessages, message)
			}
		}
	}
	appendHuman := func(message orderedNodeJSON) {
		entry := nodeObject()
		// JSON.stringify drops an undefined name, which is exactly what pinned writes when the request body has no user_name.
		if !userName.isUndefined() {
			entry.setMember("name", userName)
		}
		entry.setMember("is_user", nodeBool(true))
		entry.setMember("send_date", jsNumberCoerce(nodeGet(message, "createdAt")))
		entry.setMember("mes", jsNullish(nodeGet(message, "text"), orderedNodeJSON{kind: nodeUndefinedKind}))
		lines = append(lines, entry)
	}
	appendAI := func(message orderedNodeJSON) error {
		newest, swipes, err := byafNewestOutput(message)
		if err != nil {
			return err
		}
		entry := nodeObject()
		entry.setMember("name", nodeString(characterName))
		entry.setMember("is_user", nodeBool(false))
		entry.setMember("send_date", jsNumberCoerce(nodeGet(newest, "createdAt")))
		entry.setMember("mes", jsNullish(nodeGet(newest, "text"), orderedNodeJSON{kind: nodeUndefinedKind}))
		entry.setMember("swipes", nodeArray(swipes...))
		entry.setMember("swipe_id", nodeNumber(float64(indexOfNode(swipes, nodeGet(newest, "text")))))
		lines = append(lines, entry)
		return nil
	}

	if messages.kind == 'a' && len(userMessages) > 0 && len(userMessages) == len(characterMessages) {
		for index := range userMessages {
			appendHuman(userMessages[index])
			if err := appendAI(characterMessages[index]); err != nil {
				return "", err
			}
		}
	} else if messages.kind == 'a' {
		for _, message := range messages.array {
			if kind, _ := nodeGet(message, "type").stringValue(); kind == "human" {
				appendHuman(message)
				continue
			}
			if err := appendAI(message); err != nil {
				return "", err
			}
		}
	}

	encoded := make([]string, 0, len(lines))
	for _, line := range lines {
		body, err := marshalCharacterJSON(line)
		if err != nil {
			return "", err
		}
		encoded = append(encoded, string(body))
	}
	return strings.Join(encoded, "\n"), nil
}

// setSendDate writes the JS `send_date` value, dropping it when undefined just
// as JSON.stringify does.
func setSendDate(target *orderedNodeJSON, value orderedNodeJSON) {
	if value.isUndefined() {
		return
	}
	target.setMember("send_date", value)
}

// byafNewestOutput mirrors getNewestAiMessage + getSwipesForAiMessage.
func byafNewestOutput(message orderedNodeJSON) (orderedNodeJSON, []orderedNodeJSON, error) {
	outputs := nodeGet(message, "outputs")
	if outputs.kind != 'a' || len(outputs.array) == 0 {
		return orderedNodeJSON{}, nil, errors.New("BYAF scenario message has no outputs")
	}
	swipes := make([]orderedNodeJSON, 0, len(outputs.array))
	newest := outputs.array[0]
	for _, output := range outputs.array {
		swipes = append(swipes, jsNullish(nodeGet(output, "text"), orderedNodeJSON{kind: nodeUndefinedKind}))
		if byafOutputTimestamp(output) >= byafOutputTimestamp(newest) {
			newest = output
		}
	}
	return newest, swipes, nil
}

// byafOutputTimestamp mirrors `new Date(value)` ordering for the reduce.
func byafOutputTimestamp(output orderedNodeJSON) float64 {
	value := nodeGet(output, "activeTimestamp")
	switch value.kind {
	case 'v':
		number, _ := value.scalar.(float64)
		return number
	case 's':
		text, _ := value.scalar.(string)
		if parsed, err := time.Parse(time.RFC3339, text); err == nil {
			return float64(parsed.UnixMilli())
		}
	}
	return 0
}

// indexOfNode mirrors Array.prototype.findIndex with strict equality for the
// JSON values the swipes array holds.
func indexOfNode(haystack []orderedNodeJSON, needle orderedNodeJSON) int {
	for index, item := range haystack {
		left, leftOK := jsStringOf(item)
		right, rightOK := jsStringOf(needle)
		if leftOK && rightOK && item.kind == needle.kind && left == right {
			return index
		}
	}
	return -1
}

// encodeURIString mirrors JavaScript encodeURI for the character set pinned puts
// inside the CSS url().
func encodeURIString(value string) string {
	var builder strings.Builder
	const unreserved = "-_.!~*'()"
	for _, character := range value {
		if unicode.IsLetter(character) || unicode.IsDigit(character) || strings.ContainsRune(unreserved+"/?:@&=+$,#;", character) {
			builder.WriteRune(character)
			continue
		}
		encoded := []byte(string(character))
		for _, item := range encoded {
			builder.WriteString("%" + strings.ToUpper(itoaHex(int(item))))
		}
	}
	return builder.String()
}

func itoaHex(value int) string {
	const digits = "0123456789ABCDEF"
	if value < 16 {
		return string(digits[value])
	}
	return string(digits[value/16]) + string(digits[value%16])
}

// importFromByaf mirrors importFromByaf (src/endpoints/characters.js:803-874).
func (runtime *accountRuntime) importFromByaf(uploadPath, preservedFileName string, directories map[string]string, account *storedAccount, userName orderedNodeJSON) (string, bool) {
	raw, err := os.ReadFile(uploadPath)
	if err != nil {
		return "", true
	}
	removeStagedCharacterUpload(uploadPath)
	reader, err := openPinnedZip(raw)
	if err != nil {
		return "", true
	}
	manifestBuffer := extractFileFromZipBuffer(reader, "manifest.json")
	if manifestBuffer == nil {
		return "", true
	}
	manifest, err := decodeOrderedNodeJSON(manifestBuffer)
	if err != nil || manifest.kind != 'o' {
		return "", true
	}
	characters := nodeGet(manifest, "characters")
	if characters.kind != 'a' || len(characters.array) == 0 {
		return "", true
	}
	characterPath, ok := characters.array[0].stringValue()
	if !ok || characterPath == "" {
		return "", true
	}
	characterBuffer := extractFileFromZipBuffer(reader, characterPath)
	if characterBuffer == nil {
		return "", true
	}
	character, err := decodeOrderedNodeJSON(characterBuffer)
	if err != nil || character.kind != 'o' {
		return "", true
	}

	scenarios := byafScenarios(reader, manifest)
	images := byafCharacterImages(reader, character, characterPath)
	card := readFromV2(byafCharacterCard(manifest, character, scenarios))

	nameValue := jsOr(nodeGet(character, "displayName"), nodeGet(card, "name"))
	nameText, ok := nameValue.stringValue()
	if !ok {
		return "", true
	}
	safeName := userdata.SanitizeFilename(nameText, "_")
	fileName := preservedFileName
	if fileName == "" {
		fileName, err = getPngName(nodeString(safeName), directories)
		if err != nil {
			return "", true
		}
	}

	if preservedFileName == "" {
		if failed := runtime.persistByafScenarioState(reader, account, directories, card, character, scenarios, images, fileName, userName); failed {
			return "", true
		}
	}

	encodedAvatar, err := reencodeImageToPNG(images[0].image)
	if err != nil {
		return "", true
	}
	data, err := marshalCharacterJSON(card)
	if err != nil {
		return "", true
	}
	if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), fileName, encodedAvatar, string(data)); err != nil {
		return "", true
	}
	return fileName, false
}

// persistByafScenarioState mirrors the non-preserved half of importFromByaf:
// chats per scenario, backgrounds per distinct background image, alternate icons,
// and the card's default-chat pointer.
func (runtime *accountRuntime) persistByafScenarioState(reader *zip.Reader, account *storedAccount, directories map[string]string, card orderedNodeJSON, character orderedNodeJSON, scenarios []orderedNodeJSON, images []byafImage, fileName string, userName orderedNodeJSON) bool {
	fileNameStem := strings.TrimSuffix(fileName, path.Ext(fileName))
	backgrounds := byafChatBackgrounds(reader, character, scenarios)
	// THE NAME UPDATE MUST REACH THE SLICE THE CHATS ARE GENERATED FROM, so this
	// loop indexes instead of ranging over values: pinned writes the background
	// first and then uses bg.name (the client-relative path) inside chat_metadata.
	for backgroundIndex := range backgrounds {
		background := &backgrounds[backgroundIndex]
		extension := path.Ext(background.paths[0])
		if extension == "" {
			extension = ".png"
		}
		relativeDirectory := filepath.ToSlash(filepath.Join("user", "images", fileName))
		absoluteDirectory := filepath.Join(directories["userImages"], fileName)
		if err := os.MkdirAll(absoluteDirectory, 0o777); err != nil {
			return true
		}
		baseName := fileNameStem + "_bg"
		uniqueName := getUniqueName(baseName, func(candidate string) bool {
			_, statErr := os.Stat(filepath.Join(absoluteDirectory, candidate+extension))
			return statErr == nil
		})
		if uniqueName == "" {
			return true
		}
		target := filepath.Join(absoluteDirectory, uniqueName+extension)
		if err := writeUserContentBytes(runtime.options.DataRoot, account.string("handle"), filepath.ToSlash(filepath.Join(relativeDirectory, uniqueName+extension)), background.data); err != nil {
			return true
		}
		relative, relErr := clientRelativePath(directories["root"], target)
		if relErr != nil {
			return true
		}
		background.name = relative
	}

	chats := make([]string, 0, len(scenarios))
	for _, scenario := range scenarios {
		title := jsStringOrEmpty(nodeGet(scenario, "title"))
		cardName := jsStringOrEmpty(nodeGet(card, "name"))
		if title == "" {
			title = cardName
		}
		chatName := userdata.SanitizeFilename(title+" - "+humanizedDateTime(time.Now())+" imported.jsonl", "_")
		chatBody, err := byafChatFromScenario(scenario, userName, cardName, backgrounds)
		if err != nil {
			return true
		}
		if mkdirErr := os.MkdirAll(filepath.Join(directories["chats"], fileNameStem), 0o777); mkdirErr != nil {
			return true
		}
		relativePath := filepath.ToSlash(filepath.Join("chats", fileNameStem, chatName))
		if err := writeUserContentBytes(runtime.options.DataRoot, account.string("handle"), relativePath, []byte(chatBody)); err != nil {
			return true
		}
		chats = append(chats, chatName)
	}
	if len(chats) > 0 {
		card.setMember("chat", nodeString(strings.TrimSuffix(chats[0], path.Ext(chats[0]))))
	}

	for _, icon := range images[1:] {
		nameString := jsStringOrEmpty(nodeGet(card, "name"))
		iconFolder := userdata.SanitizeFilename(nameString, "")
		if iconFolder == "" {
			continue
		}
		extension := path.Ext(icon.filename)
		if extension == "" {
			extension = ".png"
		}
		absoluteDirectory := filepath.Join(directories["characters"], iconFolder)
		if err := os.MkdirAll(absoluteDirectory, 0o777); err != nil {
			continue
		}
		baseName := userdata.SanitizeFilename(icon.label, "_")
		if baseName == "" {
			baseName = "alt"
		}
		uniqueName := getUniqueName(baseName, func(candidate string) bool {
			_, statErr := os.Stat(filepath.Join(absoluteDirectory, candidate+extension))
			return statErr == nil
		})
		if uniqueName == "" {
			continue
		}
		_ = writeUserContentBytes(runtime.options.DataRoot, account.string("handle"), filepath.ToSlash(filepath.Join("characters", iconFolder, uniqueName+extension)), icon.image)
	}
	return false
}

// ---------------------------------------------------------------------------------------------------------------
// RisuAI sprite side effects (src/endpoints/sprites.js importRisuSprites).
// ---------------------------------------------------------------------------------------------------------------

// importRisuSprites mirrors importRisuSprites: base64 sprites from
// data.extensions.risuai.{additionalAssets,emotions} land in
// characters/<name>/, then those two arrays are deleted from the card data.
// Every failure is swallowed, exactly as the pinned function's try/catch does.
func (runtime *accountRuntime) importRisuSprites(account *storedAccount, directories map[string]string, data *orderedNodeJSON) {
	name := nodeGet(*data, "data", "name")
	risuData := nodeGet(*data, "data", "extensions", "risuai")
	if !jsTruthy(name) || risuData.kind != 'o' {
		return
	}
	images := make([]orderedNodeJSON, 0, 8)
	for _, key := range []string{"additionalAssets", "emotions"} {
		value := nodeGet(risuData, key)
		if value.kind == 'a' {
			images = append(images, value.array...)
		}
	}
	if len(images) == 0 {
		return
	}
	nameText, ok := name.stringValue()
	if !ok {
		return
	}
	spritesPath := filepath.Join(directories["characters"], startup.SanitizeUserFilename(nameText))
	if err := os.MkdirAll(spritesPath, 0o777); err != nil {
		return
	}
	info, err := os.Stat(spritesPath)
	if err != nil || !info.IsDir() {
		return
	}
	entries, err := os.ReadDir(spritesPath)
	if err != nil {
		return
	}
	for _, image := range images {
		if image.kind != 'a' || len(image.array) < 2 {
			continue
		}
		label, labelOK := image.array[0].stringValue()
		encoded, encodedOK := image.array[1].stringValue()
		if !labelOK || !encodedOK {
			continue
		}
		exists := false
		for _, entry := range entries {
			if strings.TrimSuffix(entry.Name(), path.Ext(entry.Name())) == label {
				exists = true
				break
			}
		}
		if exists {
			continue
		}
		body, decodeErr := base64.StdEncoding.DecodeString(encoded)
		if decodeErr != nil {
			continue
		}
		relativePath := filepath.ToSlash(filepath.Join("characters", startup.SanitizeUserFilename(nameText), startup.SanitizeUserFilename(label+".png")))
		_ = writeUserContentBytes(runtime.options.DataRoot, account.string("handle"), relativePath, body)
	}
	// The deletion happens on the CARD, not on the nodeGet copy: the two arrays
	// are removed from the imported data itself (sprites.js:108-110).
	nodeUnset(data, "data", "extensions", "risuai", "additionalAssets")
	nodeUnset(data, "data", "extensions", "risuai", "emotions")
}

// ---------------------------------------------------------------------------------------------------------------
// Compile-time dependencies on the blank image decoders above so a future tidy
// does not silently drop WebP/BMP/TIFF avatar support.
// ---------------------------------------------------------------------------------------------------------------

var _ = unicode.IsLetter
