package server

// Pinned character-card handling for the /api/characters domain.
//
// Upstream reads the card JSON out of the PNG `chara`/`ccv3` tEXt chunks
// (src/character-card-parser.js) and rewrites those chunks through
// src/png/encode.js. This file reproduces that chunk layout exactly and the
// processCharacter projection from src/endpoints/characters.js.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	// avatarWidth/avatarHeight are the pinned constants.js AVATAR_WIDTH/AVATAR_HEIGHT.
	avatarWidth  = 512
	avatarHeight = 768
	// defaultAvatarAsset is the pinned DEFAULT_AVATAR_PATH ('./public/img/ai4.png')
	// resolved against the embedded upstream tree.
	defaultAvatarAsset = "public/img/ai4.png"
	// maxJavaScriptStringLength is V8's maximum string length on 64-bit builds.
	// Exceeding it raises the RangeError that /api/characters/all reports as
	// `overflow: true`.
	maxJavaScriptStringLength = 536870888
)

var errJavaScriptRange = errors.New("javascript string length exceeded")

type pngChunk struct {
	name string
	data []byte
}

// extractPngChunks mirrors png-chunks-extract: it validates the signature and
// each chunk CRC, requires IHDR first, and stops at IEND (ignoring trailing
// bytes).
func extractPngChunks(image []byte) ([]pngChunk, error) {
	signature := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	if len(image) < 8 || !bytes.Equal(image[:8], signature) {
		return nil, errors.New("Invalid .png file header")
	}
	chunks := make([]pngChunk, 0, 8)
	index := 8
	for index < len(image) {
		if index+8 > len(image) {
			return nil, errors.New(".png file ended prematurely: no IEND header was found")
		}
		length := int(binary.BigEndian.Uint32(image[index:]))
		index += 4
		if length < 0 || index+4+length+4 > len(image) {
			return nil, errors.New(".png file ended prematurely: no IEND header was found")
		}
		name := string(image[index : index+4])
		if len(chunks) == 0 && name != "IHDR" {
			return nil, errors.New("IHDR header missing")
		}
		if name == "IEND" {
			chunks = append(chunks, pngChunk{name: name})
			return chunks, nil
		}
		data := image[index+4 : index+4+length]
		expected := binary.BigEndian.Uint32(image[index+4+length:])
		if crc32.ChecksumIEEE(image[index:index+4+length]) != expected {
			return nil, errors.New("CRC values for " + name + " header do not match, PNG file is likely corrupted")
		}
		chunks = append(chunks, pngChunk{name: name, data: append([]byte(nil), data...)})
		index += 4 + length + 4
	}
	return nil, errors.New(".png file ended prematurely: no IEND header was found")
}

// encodePngChunks mirrors src/png/encode.js.
func encodePngChunks(chunks []pngChunk) []byte {
	size := 8
	for _, chunk := range chunks {
		size += len(chunk.data) + 12
	}
	output := make([]byte, 0, size)
	output = append(output, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
	var scratch [4]byte
	for _, chunk := range chunks {
		binary.BigEndian.PutUint32(scratch[:], uint32(len(chunk.data)))
		output = append(output, scratch[:]...)
		output = append(output, chunk.name...)
		output = append(output, chunk.data...)
		digest := crc32.Update(crc32.ChecksumIEEE([]byte(chunk.name)), crc32.IEEETable, chunk.data)
		binary.BigEndian.PutUint32(scratch[:], digest)
		output = append(output, scratch[:]...)
	}
	return output
}

// decodePngText mirrors png-chunk-text decode, including its rejection of a
// NUL byte inside the text payload.
func decodePngText(data []byte) (keyword string, text string, err error) {
	var name strings.Builder
	var body strings.Builder
	naming := true
	for _, code := range data {
		if naming {
			if code == 0 {
				naming = false
				continue
			}
			name.WriteByte(code)
			continue
		}
		if code == 0 {
			return "", "", errors.New("Invalid NULL character found. 0x00 character is not permitted in tEXt content")
		}
		body.WriteByte(code)
	}
	return name.String(), body.String(), nil
}

// encodePngText mirrors png-chunk-text encode.
func encodePngText(keyword, content string) (pngChunk, error) {
	if !isLatin1(keyword) || !isLatin1(content) {
		return pngChunk{}, errors.New("Only Latin-1 characters are permitted in PNG tEXt chunks")
	}
	if len(keyword) >= 80 {
		return pngChunk{}, errors.New("keyword is longer than the 79-character limit imposed by the PNG specification")
	}
	if strings.IndexByte(keyword, 0) >= 0 || strings.IndexByte(content, 0) >= 0 {
		return pngChunk{}, errors.New("0x00 character is not permitted in tEXt chunks")
	}
	data := make([]byte, 0, len(keyword)+len(content)+1)
	data = append(data, keyword...)
	data = append(data, 0)
	data = append(data, content...)
	return pngChunk{name: "tEXt", data: data}, nil
}

func isLatin1(value string) bool {
	for _, character := range value {
		if character > 0xFF {
			return false
		}
	}
	return true
}

// readPngCardText mirrors character-card-parser.read: `ccv3` takes precedence
// over `chara`, and a PNG without character metadata is an error.
func readPngCardText(image []byte) (string, error) {
	chunks, err := extractPngChunks(image)
	if err != nil {
		return "", err
	}
	type textEntry struct {
		keyword string
		text    string
	}
	texts := make([]textEntry, 0, 2)
	for _, chunk := range chunks {
		if chunk.name != "tEXt" {
			continue
		}
		keyword, text, err := decodePngText(chunk.data)
		if err != nil {
			return "", err
		}
		texts = append(texts, textEntry{keyword: keyword, text: text})
	}
	if len(texts) == 0 {
		return "", errors.New("No PNG metadata.")
	}
	for _, entry := range texts {
		if strings.EqualFold(entry.keyword, "ccv3") {
			return decodeBase64UTF8(entry.text)
		}
	}
	for _, entry := range texts {
		if strings.EqualFold(entry.keyword, "chara") {
			return decodeBase64UTF8(entry.text)
		}
	}
	return "", errors.New("No PNG metadata.")
}

func decodeBase64UTF8(text string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(strings.TrimSpace(text), "="))
		if err != nil {
			return "", err
		}
	}
	return string(decoded), nil
}

// writePngCard mirrors character-card-parser.write: existing `chara`/`ccv3`
// tEXt chunks are removed and a fresh `chara` (plus best-effort `ccv3`) pair is
// inserted before IEND.
func writePngCard(image []byte, data string) ([]byte, error) {
	chunks, err := extractPngChunks(image)
	if err != nil {
		return nil, err
	}
	filtered := make([]pngChunk, 0, len(chunks)+2)
	for _, chunk := range chunks {
		if chunk.name == "tEXt" {
			keyword, _, err := decodePngText(chunk.data)
			if err == nil && (strings.EqualFold(keyword, "chara") || strings.EqualFold(keyword, "ccv3")) {
				continue
			}
		}
		filtered = append(filtered, chunk)
	}
	charaChunk, err := encodePngText("chara", base64.StdEncoding.EncodeToString([]byte(data)))
	if err != nil {
		return nil, err
	}
	inserted := append([]pngChunk(nil), filtered[:len(filtered)-1]...)
	inserted = append(inserted, charaChunk)
	if v3, err := v3CardChunk(data); err == nil {
		inserted = append(inserted, v3)
	}
	inserted = append(inserted, filtered[len(filtered)-1])
	return encodePngChunks(inserted), nil
}

// v3CardChunk mirrors the best-effort `ccv3` chunk that pinned write() adds.
func v3CardChunk(data string) (pngChunk, error) {
	parsed, err := decodeOrderedNodeJSON([]byte(data))
	if err != nil {
		return pngChunk{}, err
	}
	if parsed.kind != 'o' {
		return pngChunk{}, errors.New("character data is not an object")
	}
	nodeSet(&parsed, []string{"spec"}, nodeString("chara_card_v3"))
	nodeSet(&parsed, []string{"spec_version"}, nodeString("3.0"))
	encoded, err := marshalCharacterJSON(parsed)
	if err != nil {
		return pngChunk{}, err
	}
	return encodePngText("ccv3", base64.StdEncoding.EncodeToString(encoded))
}

// readCharacterData reads the card JSON for one PNG file.
func readCharacterData(filePath string) (string, bool) {
	text, err := readCharacterDataStrict(filePath)
	if err != nil {
		return "", false
	}
	return text, true
}

// readCharacterDataStrict reports the pinned read failure instead of collapsing
// it, which /merge-attributes needs in order to distinguish a thrown error from
// the empty-payload `Invalid character file` result.
func readCharacterDataStrict(filePath string) (string, error) {
	image, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}
	return readPngCardText(image)
}

// errorCharacter is the object pinned processCharacter returns after any
// failure.
func errorCharacter() orderedNodeJSON {
	character := nodeObject()
	character.setMember("date_added", nodeNumber(0))
	character.setMember("date_last_chat", nodeNumber(0))
	character.setMember("chat_size", nodeNumber(0))
	return character
}

// processCharacter mirrors pinned processCharacter.
func processCharacter(item string, directories map[string]string, shallow bool) orderedNodeJSON {
	imgFile := filepath.Join(directories["characters"], item)
	imgData, ok := readCharacterData(imgFile)
	if !ok {
		return errorCharacter()
	}
	parsed, err := decodeOrderedNodeJSON([]byte(imgData))
	if err != nil {
		return errorCharacter()
	}
	jsonObject := getCharaCardV2(parsed, directories, false)
	nodeSet(&jsonObject, []string{"avatar"}, nodeString(item))
	nodeSet(&jsonObject, []string{"json_data"}, nodeString(imgData))

	info, err := os.Stat(imgFile)
	if err != nil {
		return errorCharacter()
	}
	ctimeMs := nodeFileCtimeMilliseconds(imgFile, info)
	nodeSet(&jsonObject, []string{"date_added"}, nodeNumber(ctimeMs))
	createDate := nodeGet(jsonObject, "create_date")
	if !createDate.truthy() {
		nodeSet(&jsonObject, []string{"create_date"}, nodeString(isoStringFromMilliseconds(ctimeMs)))
	}

	chatsDirectory := filepath.Join(directories["chats"], strings.Replace(item, ".png", "", 1))
	chatSize, dateLastChat, err := calculateChatSize(chatsDirectory)
	if err != nil {
		return errorCharacter()
	}
	nodeSet(&jsonObject, []string{"chat_size"}, nodeNumber(chatSize))
	nodeSet(&jsonObject, []string{"date_last_chat"}, nodeNumber(dateLastChat))

	dataSize, err := calculateDataSize(nodeGet(jsonObject, "data"))
	if err != nil {
		return errorCharacter()
	}
	nodeSet(&jsonObject, []string{"data_size"}, nodeNumber(dataSize))

	if shallow {
		return toShallow(jsonObject)
	}
	return jsonObject
}

// calculateChatSize mirrors pinned calculateChatSize. Directories count too,
// because the pinned implementation stats every directory entry.
func calculateChatSize(charDir string) (float64, float64, error) {
	chatSize := 0.0
	dateLastChat := 0.0
	entries, err := os.ReadDir(charDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return chatSize, dateLastChat, nil
		}
		return 0, 0, err
	}
	for _, entry := range entries {
		info, err := os.Stat(filepath.Join(charDir, entry.Name()))
		if err != nil {
			return 0, 0, err
		}
		chatSize += float64(info.Size())
		modified := float64(info.ModTime().UnixNano()) / 1e6
		if modified > dateLastChat {
			dateLastChat = modified
		}
	}
	return chatSize, dateLastChat, nil
}

// calculateDataSize mirrors pinned calculateDataSize, including the TypeError
// that Object.values(null) raises and V8's RangeError for oversized strings.
func calculateDataSize(data orderedNodeJSON) (float64, error) {
	total := 0.0
	switch data.kind {
	case 'o':
		for _, entry := range data.object {
			size, err := characterStringLength(entry.value)
			if err != nil {
				return 0, err
			}
			total += size
		}
	case 'a':
		for _, item := range data.array {
			size, err := characterStringLength(item)
			if err != nil {
				return 0, err
			}
			total += size
		}
	case 'n':
		return 0, errors.New("cannot convert null to object")
	default:
		return 0, nil
	}
	return total, nil
}

func characterStringLength(value orderedNodeJSON) (float64, error) {
	text, err := characterString(value)
	if err != nil {
		return 0, err
	}
	if len(text) > maxJavaScriptStringLength {
		return 0, errJavaScriptRange
	}
	// JavaScript string length counts UTF-16 code units.
	return float64(len(utf16.Encode([]rune(text)))), nil
}

// toShallow mirrors pinned toShallow.
func toShallow(character orderedNodeJSON) orderedNodeJSON {
	shallow := nodeObject()
	shallow.setMember("shallow", nodeBool(true))
	for _, key := range []string{"name", "avatar", "chat", "fav", "date_added", "create_date", "date_last_chat", "chat_size", "data_size", "tags"} {
		value, exists := character.member(key)
		if !exists {
			value = nodeUndefined()
		}
		shallow.setMember(key, value)
	}
	data := nodeObject()
	data.setMember("name", nodeGetString(character, "", "data", "name"))
	data.setMember("character_version", nodeGetString(character, "", "data", "character_version"))
	data.setMember("creator", nodeGetString(character, "", "data", "creator"))
	data.setMember("creator_notes", nodeGetString(character, "", "data", "creator_notes"))
	data.setMember("tags", nodeGetArray(character, "data", "tags"))
	extensions := nodeObject()
	extensions.setMember("fav", nodeGetBool(character, false, "data", "extensions", "fav"))
	extensions.setMember("world", nodeGetString(character, "", "data", "extensions", "world"))
	data.setMember("extensions", extensions)
	shallow.setMember("data", data)
	return shallow
}

// humanizedDateTime mirrors pinned util.js humanizedDateTime (local time).
func humanizedDateTime(timestamp time.Time) string {
	return timestamp.Format("2006-01-02") + "@" + timestamp.Format("15h04m05s") + padMilliseconds(timestamp.Nanosecond()/1e6) + "ms"
}

func padMilliseconds(value int) string {
	digits := []byte{byte('0' + value/100%10), byte('0' + value/10%10), byte('0' + value%10)}
	return string(digits)
}

func isoStringFromMilliseconds(milliseconds float64) string {
	rounded := math.Round(milliseconds)
	seconds := int64(rounded) / 1000
	remainder := int64(rounded) - seconds*1000
	return time.Unix(seconds, remainder*int64(time.Millisecond)).UTC().Format("2006-01-02T15:04:05.000Z")
}
