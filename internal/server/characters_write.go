package server

// Pinned character write routes: create, rename, edit, edit-avatar,
// edit-attribute, merge-attributes, delete, duplicate and export.

import (
	"bytes"
	"errors"
	"image"
	"image/draw"
	"image/png"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/upstream"
	xdraw "golang.org/x/image/draw"
)

// avatarCrop mirrors the pinned Crop typedef.
type avatarCrop struct {
	x          float64
	y          float64
	width      float64
	height     float64
	wantResize bool
}

// parseAvatarCrop mirrors `tryParse(request.query.crop)` plus the numeric guard
// inside applyAvatarCropResize. A non-object or partially numeric crop is
// ignored, matching the pinned typeof checks.
func parseAvatarCrop(query string) *avatarCrop {
	if query == "" {
		return nil
	}
	parsed, err := decodeOrderedNodeJSON([]byte(query))
	if err != nil || parsed.kind != 'o' {
		return nil
	}
	fields := make([]float64, 0, 4)
	for _, key := range []string{"x", "y", "width", "height"} {
		value, exists := parsed.member(key)
		if !exists || value.kind != 'v' {
			return nil
		}
		number, ok := value.scalar.(float64)
		if !ok {
			return nil
		}
		fields = append(fields, number)
	}
	return &avatarCrop{
		x: fields[0], y: fields[1], width: fields[2], height: fields[3],
		wantResize: jsTruthy(nodeGet(parsed, "want_resize")),
	}
}

// cardImageBytes reproduces the pinned getInputImage/tryReadImage selection.
//
// The pinned code decodes and re-encodes every image through Jimp. GoTavern
// keeps the source bytes when no crop applies (identical pixels, different PNG
// encoder) and only decodes when a crop or a non-PNG upload requires it.
func cardImageBytes(sourcePath string, crop *avatarCrop) []byte {
	raw, err := os.ReadFile(sourcePath)
	if err != nil {
		return defaultAvatarBytes()
	}
	if crop == nil {
		return raw
	}
	if encoded, ok := reencodeImage(raw, crop); ok {
		return encoded
	}
	return raw
}

func defaultAvatarBytes() []byte {
	body, err := upstream.Assets.ReadFile("default/content/default_avatar.png")
	if err != nil {
		body, _ = upstream.Assets.ReadFile(defaultAvatarAsset)
	}
	return body
}

// reencodeImage decodes the image, applies the pinned crop/cover geometry and
// re-encodes it as PNG.
func reencodeImage(raw []byte, crop *avatarCrop) ([]byte, bool) {
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, false
	}
	current := toNRGBA(decoded)
	finalWidth := current.Bounds().Dx()
	finalHeight := current.Bounds().Dy()
	if crop != nil {
		cropped, ok := cropImage(current, crop)
		if !ok {
			return nil, false
		}
		current = cropped
		if crop.wantResize {
			finalWidth = avatarWidth
			finalHeight = avatarHeight
		} else {
			finalWidth = int(crop.width)
			finalHeight = int(crop.height)
		}
	}
	current = coverImage(current, finalWidth, finalHeight)
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, current); err != nil {
		return nil, false
	}
	return buffer.Bytes(), true
}

func toNRGBA(source image.Image) *image.NRGBA {
	if existing, ok := source.(*image.NRGBA); ok && existing.Bounds().Min == (image.Point{}) {
		return existing
	}
	bounds := source.Bounds()
	target := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	draw.Draw(target, target.Bounds(), source, bounds.Min, draw.Src)
	return target
}

func cropImage(source *image.NRGBA, crop *avatarCrop) (*image.NRGBA, bool) {
	x := int(math.Round(crop.x))
	y := int(math.Round(crop.y))
	width := int(math.Round(crop.width))
	height := int(math.Round(crop.height))
	if width <= 0 || height <= 0 {
		return nil, false
	}
	target := image.NewNRGBA(image.Rect(0, 0, width, height))
	draw.Draw(target, target.Bounds(), source, image.Point{X: x, Y: y}, draw.Src)
	return target, true
}

// coverImage mirrors Jimp's cover(): scale so the image covers the target box,
// then center-crop to the exact size.
func coverImage(source *image.NRGBA, width, height int) *image.NRGBA {
	if width <= 0 || height <= 0 {
		return source
	}
	sourceWidth := source.Bounds().Dx()
	sourceHeight := source.Bounds().Dy()
	if sourceWidth == width && sourceHeight == height {
		return source
	}
	scale := math.Max(float64(width)/float64(sourceWidth), float64(height)/float64(sourceHeight))
	scaledWidth := int(math.Ceil(float64(sourceWidth) * scale))
	scaledHeight := int(math.Ceil(float64(sourceHeight) * scale))
	scaled := image.NewNRGBA(image.Rect(0, 0, scaledWidth, scaledHeight))
	xdraw.BiLinear.Scale(scaled, scaled.Bounds(), source, source.Bounds(), xdraw.Src, nil)
	target := image.NewNRGBA(image.Rect(0, 0, width, height))
	offsetX := (scaledWidth - width) / 2
	offsetY := (scaledHeight - height) / 2
	draw.Draw(target, target.Bounds(), scaled, image.Point{X: offsetX, Y: offsetY}, draw.Src)
	return target
}

// writeCharacterCard atomically replaces one character PNG under the shared
// per-user content lock.
func writeCharacterCard(dataRoot, handle, outputName string, imageBytes []byte, data string) error {
	output, err := writePngCard(imageBytes, data)
	if err != nil {
		return err
	}
	relativePath := filepath.Join("characters", outputName+".png")
	return startup.UpdateUserContentFile(dataRoot, handle, relativePath, func([]byte) ([]byte, error) {
		return output, nil
	})
}

// jsTemplateString mirrors `${value}` interpolation for JSON values.
func jsTemplateString(value orderedNodeJSON) string {
	text, err := characterString(value)
	if err != nil {
		return "[object Object]"
	}
	return text
}

// sanitizeCharacterName applies the pinned sanitize-filename call.
func sanitizeCharacterName(value orderedNodeJSON) (string, error) {
	text, ok := value.stringValue()
	if !ok {
		return "", errors.New("Input must be string")
	}
	return startup.SanitizeUserFilename(text), nil
}

func (runtime *accountRuntime) serveCharactersCreate(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body := parsed.body
	chName, err := sanitizeCharacterName(nodeGet(body, "ch_name"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	nodeSet(&body, []string{"ch_name"}, nodeString(chName))

	char := charaFormatData(body, directories)
	encoded, err := marshalCharacterJSON(char)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	internalName := ""
	if fileName := nodeGet(body, "file_name"); jsTruthy(fileName) {
		text, ok := fileName.stringValue()
		if !ok {
			// path.join rejects the non-string name before the outer catch.
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		internalName = text
	} else {
		internalName, err = getPngName(nodeString(chName), directories)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	avatarName := internalName + ".png"
	chatsPath := filepath.Join(directories["chats"], internalName)
	if _, err := os.Stat(chatsPath); err != nil {
		if err := os.Mkdir(chatsPath, 0o777); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}

	var imageBytes []byte
	if parsed.stagedPath == "" {
		imageBytes = defaultAvatarBytes()
	} else {
		imageBytes = cardImageBytes(parsed.stagedPath, parseAvatarCrop(request.URL.Query().Get("crop")))
		removeStagedCharacterUpload(parsed.stagedPath)
	}
	_ = writeCharacterCard(runtime.options.DataRoot, account.string("handle"), internalName, imageBytes, string(encoded))
	respondText(w, http.StatusOK, "text/html; charset=utf-8", avatarName)
}

func (runtime *accountRuntime) serveCharactersRename(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	body := parsed.body
	if !validateCharactersFilenameField(w, body, "avatar_url") {
		return
	}
	if !jsTruthy(nodeGet(body, "avatar_url")) || !jsTruthy(nodeGet(body, "new_name")) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	oldAvatarName, isString := nodeGet(body, "avatar_url").stringValue()
	if !isString {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	newName, err := sanitizeCharacterName(nodeGet(body, "new_name"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	oldInternalName := strings.TrimSuffix(oldAvatarName, nodePathExt(oldAvatarName))
	newInternalName, err := getPngName(nodeString(newName), directories)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	newAvatarName := newInternalName + ".png"
	oldAvatarPath := filepath.Join(directories["characters"], oldAvatarName)
	oldChatsPath := filepath.Join(directories["chats"], oldInternalName)
	newChatsPath := filepath.Join(directories["chats"], newInternalName)

	rawOldData, exists := readCharacterData(oldAvatarPath)
	if !exists {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	parsedCard, err := decodeOrderedNodeJSON([]byte(rawOldData))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	oldData := getCharaCardV2(parsedCard, directories, true)
	nodeSet(&oldData, []string{"data", "name"}, nodeString(newName))
	nodeSet(&oldData, []string{"name"}, nodeString(newName))
	newData, err := marshalCharacterJSON(oldData)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	if _, err := os.Stat(oldChatsPath); err == nil {
		if _, destErr := os.Stat(newChatsPath); destErr != nil {
			if err := copyDirectoryRecursive(oldChatsPath, newChatsPath); err != nil {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			if err := os.RemoveAll(oldChatsPath); err != nil {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
		}
	}

	if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), newInternalName, cardImageBytes(oldAvatarPath, nil), string(newData)); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if _, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), filepath.Join("characters", oldAvatarName)); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	response := nodeObject()
	response.setMember("avatar", nodeString(newAvatarName))
	respondCharacterJSON(w, http.StatusOK, response)
}

func (runtime *accountRuntime) serveCharactersEdit(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	body := parsed.body
	if !validateCharactersFilenameField(w, body, "avatar_url") {
		return
	}
	if !validCharacterEditName(w, body) {
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	char := charaFormatData(body, directories)
	nodeSet(&char, []string{"chat"}, nodeGet(body, "chat"))
	nodeSet(&char, []string{"create_date"}, nodeGet(body, "create_date"))
	encoded, err := marshalCharacterJSON(char)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	avatarURL, isString := nodeGet(body, "avatar_url").stringValue()
	if !isString {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	targetFile := strings.Replace(avatarURL, ".png", "", 1)
	var imageBytes []byte
	if parsed.stagedPath == "" {
		imageBytes = cardImageBytes(filepath.Join(directories["characters"], avatarURL), nil)
	} else {
		imageBytes = cardImageBytes(parsed.stagedPath, parseAvatarCrop(request.URL.Query().Get("crop")))
		removeStagedCharacterUpload(parsed.stagedPath)
	}
	if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), targetFile, imageBytes, string(encoded)); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}

func (runtime *accountRuntime) serveCharactersEditAvatar(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if parsed.stagedPath == "" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Error: no file uploaded")
		return
	}
	defer removeStagedCharacterUpload(parsed.stagedPath)
	body := parsed.body
	if !jsTruthy(nodeGet(body, "avatar_url")) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Error: no avatar_url in request body")
		return
	}
	if !validateCharactersFilenameField(w, body, "avatar_url") {
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	avatarURL, isString := nodeGet(body, "avatar_url").stringValue()
	if !isString {
		// path.join rejects the non-string avatar before the outer catch.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if _, err := os.Stat(parsed.stagedPath); err != nil {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Error: uploaded file does not exist")
		return
	}
	characterPath := filepath.Join(directories["characters"], avatarURL)
	if _, err := os.Stat(characterPath); err != nil {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Error: character file does not exist")
		return
	}
	data, err := readCharacterDataStrict(characterPath)
	if err != nil {
		// The pinned read throws for an unreadable card and the route's outer
		// catch turns that into a 500.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if data == "" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Error: failed to read character data")
		return
	}
	fileName := strings.Replace(avatarURL, ".png", "", 1)
	imageBytes := cardImageBytes(parsed.stagedPath, parseAvatarCrop(request.URL.Query().Get("crop")))
	if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), fileName, imageBytes, data); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}

func (runtime *accountRuntime) serveCharactersEditAttribute(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	body := parsed.body
	if !validateCharactersFilenameField(w, body, "avatar_url") {
		return
	}
	if !validCharacterEditName(w, body) {
		return
	}
	if field, isString := nodeGet(body, "field").stringValue(); isString && field == "json_data" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Error: cannot edit json_data field.")
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	avatarURL, isString := nodeGet(body, "avatar_url").stringValue()
	if !isString {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	avatarPath := filepath.Join(directories["characters"], avatarURL)
	rawCard, exists := readCharacterData(avatarPath)
	if !exists {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	card, err := decodeOrderedNodeJSON([]byte(rawCard))
	if err != nil || card.kind != 'o' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	field, err := characterString(nodeGet(body, "field"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	data := nodeGet(card, "data")
	if data.kind != 'o' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	topLevel, topExists := card.member(field)
	_, dataExists := data.member(field)
	if (!topExists || topLevel.isUndefined()) && !dataExists {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Error: invalid field.")
		return
	}
	nodeSet(&card, []string{field}, nodeGet(body, "value"))
	nodeSet(&card, []string{"data", field}, nodeGet(body, "value"))
	encoded, err := marshalCharacterJSON(card)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	targetFile := strings.Replace(avatarURL, ".png", "", 1)
	if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), targetFile, cardImageBytes(avatarPath, nil), string(encoded)); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	serveStatusText(w, http.StatusOK)
}

// validCharacterEditName mirrors the pinned ch_name guard shared by /edit and
// /edit-attribute.
func validCharacterEditName(w http.ResponseWriter, body orderedNodeJSON) bool {
	chName := nodeGet(body, "ch_name")
	if text, ok := chName.stringValue(); ok {
		if text == "" || text == "." {
			respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Error: invalid name.")
			return false
		}
		return true
	}
	if chName.isUndefined() {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Error: invalid name.")
		return false
	}
	return true
}

const characterUnsetSentinel = "__@@UNSET@@__"

// mergeCharacterUpdate mirrors pinned mergeCharacterUpdate. The returned error
// is the exception the pinned code would throw; the message is the validator
// failure it would report.
func mergeCharacterUpdate(dataRoot, handle, avatarPath, avatar string, updateData orderedNodeJSON, shouldSkip func(orderedNodeJSON) bool) (bool, string, bool, error) {
	rawCard, err := readCharacterDataStrict(avatarPath)
	if err != nil {
		return false, "", false, err
	}
	if rawCard == "" {
		return false, "Invalid character file", false, nil
	}
	character, err := decodeOrderedNodeJSON([]byte(rawCard))
	if err != nil {
		return false, "", false, err
	}
	if shouldSkip != nil && shouldSkip(character) {
		return false, "", true, nil
	}
	update := nodeCloneDeep(updateData)
	nodeUnset(&update, "json_data")
	nodeUnset(&character, "json_data")
	character = deepMerge(character, update)
	processUnsetSentinels(&character, update)
	if valid, message := validateTavernCard(character); !valid {
		return false, message, false, nil
	}
	encoded, err := marshalCharacterJSON(character)
	if err != nil {
		return false, "", false, err
	}
	target := strings.Replace(avatar, ".png", "", 1)
	if err := writeCharacterCard(dataRoot, handle, target, cardImageBytes(avatarPath, nil), string(encoded)); err != nil {
		return false, "", false, err
	}
	return true, "", false, nil
}

// processUnsetSentinels mirrors pinned processUnsetSentinels, including the
// lodash path semantics of `_.unset(target, key)`.
func processUnsetSentinels(target *orderedNodeJSON, source orderedNodeJSON) {
	if source.kind != 'o' {
		return
	}
	for _, entry := range source.object {
		if text, ok := entry.value.stringValue(); ok && text == characterUnsetSentinel {
			nodeUnset(target, strings.Split(entry.key, ".")...)
			continue
		}
		if entry.value.kind == 'o' {
			child, exists := target.member(entry.key)
			if exists && child.kind == 'o' {
				processUnsetSentinels(&child, entry.value)
				target.setMember(entry.key, child)
			}
		}
	}
}

// validateTavernCard mirrors src/validator/TavernCardValidator.js: the V1, V2
// and V3 validators run in order and the reported error comes from the last one
// that ran.
func validateTavernCard(card orderedNodeJSON) (bool, string) {
	message := ""
	if valid, detail := validateCardV1(card); valid {
		return true, ""
	} else {
		message = detail
	}
	if valid, detail := validateCardV2(card); valid {
		return true, ""
	} else if detail != "" {
		message = detail
	}
	if valid, detail := validateCardV3(card); valid {
		return true, ""
	} else if detail != "" {
		message = detail
	}
	return false, message
}

func validateCardV1(card orderedNodeJSON) (bool, string) {
	for _, field := range []string{"name", "description", "personality", "scenario", "first_mes", "mes_example"} {
		if _, exists := card.member(field); !exists {
			return false, field
		}
	}
	return true, ""
}

func validateCardV2(card orderedNodeJSON) (bool, string) {
	if spec, _ := nodeGet(card, "spec").stringValue(); spec != "chara_card_v2" {
		return false, "spec"
	}
	if version, _ := nodeGet(card, "spec_version").stringValue(); version != "2.0" {
		return false, "spec_version"
	}
	data := nodeGet(card, "data")
	if !jsTruthy(data) {
		return false, "No tavern card data found"
	}
	for _, field := range []string{"name", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions", "alternate_greetings", "tags", "creator", "character_version", "extensions"} {
		if _, exists := data.member(field); !exists {
			return false, "data." + field
		}
	}
	if nodeGet(data, "alternate_greetings").kind != 'a' || nodeGet(data, "tags").kind != 'a' {
		return false, ""
	}
	if extensions := nodeGet(data, "extensions"); extensions.kind != 'o' && extensions.kind != 'n' {
		return false, ""
	}
	if book := nodeGet(data, "character_book"); jsTruthy(book) {
		for _, field := range []string{"extensions", "entries"} {
			if _, exists := book.member(field); !exists {
				return false, "data.character_book." + field
			}
		}
		if nodeGet(book, "entries").kind != 'a' || nodeGet(book, "extensions").kind != 'o' {
			return false, ""
		}
	}
	return true, ""
}

func validateCardV3(card orderedNodeJSON) (bool, string) {
	if spec, _ := nodeGet(card, "spec").stringValue(); spec != "chara_card_v3" {
		return false, "spec"
	}
	version, ok := jsNumber(nodeGet(card, "spec_version"))
	if !ok || version < 3.0 || version >= 4.0 {
		return false, "spec_version"
	}
	data := nodeGet(card, "data")
	if !jsTruthy(data) || (data.kind != 'o' && data.kind != 'a') {
		return false, "No tavern card data found"
	}
	return true, ""
}

func (runtime *accountRuntime) serveCharactersMergeAttributes(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	body := parsed.body
	if !validateCharactersFilenameField(w, body, "avatar") {
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	dataRoot := runtime.options.DataRoot
	handle := account.string("handle")

	if avatars := nodeGet(body, "avatars"); avatars.kind == 'a' {
		updateData := nodeGet(body, "data")
		if !updateData.isPlainObject() {
			respondJSONMessage(w, http.StatusBadRequest, "No valid update data provided.")
			return
		}
		targetAvatars := make([]string, 0, len(avatars.array))
		if len(avatars.array) > 0 {
			for _, avatar := range avatars.array {
				name, isString := avatar.stringValue()
				if !isString || forbiddenAvatarRegExp(name) || strings.ToLower(nodePathExt(name)) != ".png" {
					respondJSONMessage(w, http.StatusBadRequest, "Invalid avatar filename: "+jsTemplateString(avatar))
					return
				}
				targetAvatars = append(targetAvatars, name)
			}
		} else {
			entries, err := os.ReadDir(directories["characters"])
			if err != nil {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			for _, entry := range entries {
				if strings.ToLower(nodePathExt(entry.Name())) == ".png" {
					targetAvatars = append(targetAvatars, entry.Name())
				}
			}
		}
		var shouldSkip func(orderedNodeJSON) bool
		if filter := nodeGet(body, "filter"); filter.isPlainObject() {
			if path, isString := nodeGet(filter, "path").stringValue(); isString {
				shouldSkip = func(character orderedNodeJSON) bool {
					return nodeGet(character, strings.Split(path, ".")...).isUndefined()
				}
			}
		}
		updated := make([]orderedNodeJSON, 0)
		skipped := make([]orderedNodeJSON, 0)
		failed := make([]orderedNodeJSON, 0)
		for _, avatar := range targetAvatars {
			avatarPath := filepath.Join(directories["characters"], avatar)
			ok, _, wasSkipped, _ := mergeCharacterUpdate(dataRoot, handle, avatarPath, avatar, updateData, shouldSkip)
			switch {
			case ok:
				updated = append(updated, nodeString(avatar))
			case wasSkipped:
				skipped = append(skipped, nodeString(avatar))
			default:
				failed = append(failed, nodeString(avatar))
			}
		}
		response := nodeObject()
		response.setMember("updated", nodeArray(updated...))
		response.setMember("skipped", nodeArray(skipped...))
		response.setMember("failed", nodeArray(failed...))
		respondCharacterJSON(w, http.StatusOK, response)
		return
	}

	avatar, isString := nodeGet(body, "avatar").stringValue()
	if !isString {
		respondJSONError(w, http.StatusInternalServerError, "Unexpected error while saving character.", "TypeError: the path argument must be of type string")
		return
	}
	avatarPath := filepath.Join(directories["characters"], avatar)
	ok, message, _, exception := mergeCharacterUpdate(dataRoot, handle, avatarPath, avatar, body, nil)
	if ok {
		serveStatusText(w, http.StatusOK)
		return
	}
	if exception != nil {
		respondJSONError(w, http.StatusInternalServerError, "Unexpected error while saving character.", "Error: "+exception.Error())
		return
	}
	response := nodeObject()
	response.setMember("message", nodeString("Validation failed for "+avatar))
	response.setMember("error", nodeString(message))
	respondCharacterJSON(w, http.StatusBadRequest, response)
}

func respondJSONMessage(w http.ResponseWriter, status int, message string) {
	response := nodeObject()
	response.setMember("message", nodeString(message))
	respondCharacterJSON(w, status, response)
}

func respondJSONError(w http.ResponseWriter, status int, message, detail string) {
	response := nodeObject()
	response.setMember("message", nodeString(message))
	response.setMember("error", nodeString(detail))
	respondCharacterJSON(w, status, response)
}

func (runtime *accountRuntime) serveCharactersDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	body := parsed.body
	if !validateCharactersFilenameField(w, body, "avatar_url") {
		return
	}
	if !jsTruthy(nodeGet(body, "avatar_url")) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	avatarURL, isString := nodeGet(body, "avatar_url").stringValue()
	if !isString {
		// The pinned handler calls sanitize() outside any try block, so a
		// non-string avatar reaches the Express error handler.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if avatarURL != startup.SanitizeUserFilename(avatarURL) {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	avatarPath := filepath.Join(directories["characters"], avatarURL)
	if _, err := os.Stat(avatarPath); err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if _, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), filepath.Join("characters", avatarURL)); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	dirName := strings.Replace(avatarURL, ".png", "", 1)
	if dirName == "" {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	if jsLooseEqualsTrue(nodeGet(body, "delete_chats")) {
		// The pinned route uses an unlocked recursive rm here, so GoTavern
		// reproduces that (no shared content lock is held).
		target := filepath.Join(directories["chats"], startup.SanitizeUserFilename(dirName))
		if err := os.RemoveAll(target); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	serveStatusText(w, http.StatusOK)
}

// jsLooseEqualsTrue mirrors `value == true`.
func jsLooseEqualsTrue(value orderedNodeJSON) bool {
	switch value.kind {
	case 'b':
		result, _ := value.scalar.(bool)
		return result
	case 'v':
		number, _ := value.scalar.(float64)
		return number == 1
	case 's':
		text, _ := value.scalar.(string)
		if strings.TrimSpace(text) == "" {
			return false
		}
		number, ok := jsNumber(value)
		return ok && number == 1
	default:
		return false
	}
}

func (runtime *accountRuntime) serveCharactersDuplicate(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	body := parsed.body
	if !validateCharactersFilenameField(w, body, "avatar_url") {
		return
	}
	if !jsTruthy(nodeGet(body, "avatar_url")) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}
	avatarURL, isString := nodeGet(body, "avatar_url").stringValue()
	if !isString {
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}
	filename := filepath.Join(directories["characters"], startup.SanitizeUserFilename(avatarURL))
	if _, err := os.Stat(filename); err != nil {
		serveStatusText(w, http.StatusNotFound)
		return
	}
	extension := nodePathExt(filename)
	base := strings.TrimSuffix(filepath.Base(filename), extension)
	parts := strings.Split(base, "_")
	lastPart := parts[len(parts)-1]
	suffix := 1
	baseName := base
	if number, ok := jsNumber(nodeString(lastPart)); ok && len(parts) > 1 {
		suffix = int(number) + 1
		baseName = strings.Join(parts[:len(parts)-1], "_")
	}
	newFilename := filepath.Join(directories["characters"], baseName+"_"+strconv.Itoa(suffix)+extension)
	for {
		if _, err := os.Stat(newFilename); err != nil {
			break
		}
		newFilename = filepath.Join(directories["characters"], baseName+"_"+strconv.Itoa(suffix)+extension)
		suffix++
	}
	source, err := os.ReadFile(filename)
	if err != nil {
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}
	targetName := filepath.Base(newFilename)
	if err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), filepath.Join("characters", targetName), func([]byte) ([]byte, error) {
		return source, nil
	}); err != nil {
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}
	response := nodeObject()
	response.setMember("path", nodeString(targetName))
	respondCharacterJSON(w, http.StatusOK, response)
}

func (runtime *accountRuntime) serveCharactersExport(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	body := parsed.body
	if !validateCharactersFilenameField(w, body, "avatar_url") {
		return
	}
	if !jsTruthy(nodeGet(body, "format")) || !jsTruthy(nodeGet(body, "avatar_url")) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	avatarURL, isString := nodeGet(body, "avatar_url").stringValue()
	if !isString {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	filename := filepath.Join(directories["characters"], startup.SanitizeUserFilename(avatarURL))
	if _, err := os.Stat(filename); err != nil {
		serveStatusText(w, http.StatusNotFound)
		return
	}
	format, _ := nodeGet(body, "format").stringValue()
	switch format {
	case "png":
		rawBuffer, err := os.ReadFile(filename)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		rawData, err := readPngCardText(rawBuffer)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		mutatedData := mutateJsonString(rawData, unsetPrivateFields)
		mutatedBuffer, err := writePngCard(rawBuffer, mutatedData)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", staticContentType(filename))
		w.Header().Set("Content-Disposition", `attachment; filename="`+encodeURI(filepath.Base(filename))+`"`)
		// Pinned Node only adds Accept-Encoding to Vary when the response is
		// compressible; the shared GoTavern middleware always sets both, so the
		// image response restores the pinned value here.
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Content-Length", strconv.Itoa(len(mutatedBuffer)))
		w.Header().Set("ETag", expressWeakETag(mutatedBuffer))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(mutatedBuffer)
	case "json":
		rawCard, exists := readCharacterData(filename)
		if !exists {
			serveStatusText(w, http.StatusBadRequest)
			return
		}
		card, err := decodeOrderedNodeJSON([]byte(rawCard))
		if err != nil {
			serveStatusText(w, http.StatusBadRequest)
			return
		}
		jsonObject := getCharaCardV2(card, directories, true)
		unsetPrivateFields(&jsonObject)
		pretty, err := marshalCharacterJSONIndent(jsonObject)
		if err != nil {
			serveStatusText(w, http.StatusBadRequest)
			return
		}
		respondText(w, http.StatusOK, "application/json; charset=utf-8", string(pretty))
	default:
		serveStatusText(w, http.StatusBadRequest)
	}
}

// unsetPrivateFields mirrors pinned unsetPrivateFields.
func unsetPrivateFields(card *orderedNodeJSON) {
	nodeSet(card, []string{"fav"}, nodeBool(false))
	nodeSet(card, []string{"data", "extensions", "fav"}, nodeBool(false))
	nodeUnset(card, "chat")
}

// mutateJsonString mirrors util.js mutateJsonString: on any parse/mutation
// failure the original text is returned unchanged.
func mutateJsonString(jsonString string, mutation func(*orderedNodeJSON)) string {
	parsed, err := decodeOrderedNodeJSON([]byte(jsonString))
	if err != nil {
		return jsonString
	}
	mutation(&parsed)
	encoded, err := marshalCharacterJSON(parsed)
	if err != nil {
		return jsonString
	}
	return string(encoded)
}

func copyDirectoryRecursive(source, destination string) error {
	return filepath.Walk(source, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, body, info.Mode().Perm())
	})
}

// marshalCharacterJSONIndent mirrors JSON.stringify(value, null, 4).
func marshalCharacterJSONIndent(value orderedNodeJSON) ([]byte, error) {
	var body bytes.Buffer
	if err := writeCharacterJSONIndent(&body, value, 0); err != nil {
		return nil, err
	}
	return body.Bytes(), nil
}

func writeCharacterJSONIndent(body *bytes.Buffer, value orderedNodeJSON, depth int) error {
	switch value.kind {
	case 'o':
		entries, _ := value.entries()
		written := make([]orderedNodeJSONEntry, 0, len(entries))
		for _, entry := range entries {
			if entry.value.kind == nodeUndefinedKind {
				continue
			}
			written = append(written, entry)
		}
		if len(written) == 0 {
			body.WriteString("{}")
			return nil
		}
		body.WriteString("{\n")
		for index, entry := range written {
			if index > 0 {
				body.WriteString(",\n")
			}
			body.WriteString(strings.Repeat(" ", (depth+1)*4))
			keyBytes, err := marshalNodeJSONString(entry.key)
			if err != nil {
				return err
			}
			body.Write(keyBytes)
			body.WriteString(": ")
			if err := writeCharacterJSONIndent(body, entry.value, depth+1); err != nil {
				return err
			}
		}
		body.WriteString("\n" + strings.Repeat(" ", depth*4) + "}")
	case 'a':
		if len(value.array) == 0 {
			body.WriteString("[]")
			return nil
		}
		body.WriteString("[\n")
		for index, item := range value.array {
			if index > 0 {
				body.WriteString(",\n")
			}
			body.WriteString(strings.Repeat(" ", (depth+1)*4))
			if item.kind == nodeUndefinedKind {
				body.WriteString("null")
				continue
			}
			if err := writeCharacterJSONIndent(body, item, depth+1); err != nil {
				return err
			}
		}
		body.WriteString("\n" + strings.Repeat(" ", depth*4) + "]")
	default:
		return writeCharacterJSON(body, value)
	}
	return nil
}

// encodeURI mirrors JavaScript's encodeURI for the export filename.
func encodeURI(value string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'();/?:@&=+$,#"
	var encoded strings.Builder
	for _, character := range value {
		if strings.ContainsRune(unreserved, character) {
			encoded.WriteRune(character)
			continue
		}
		for _, octet := range []byte(string(character)) {
			encoded.WriteString("%" + strings.ToUpper(strconv.FormatUint(uint64(octet), 16)))
		}
	}
	return encoded.String()
}
