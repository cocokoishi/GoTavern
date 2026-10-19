package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"math/big"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
	_ "golang.org/x/image/bmp"
)

var errImageMetadataFormatUnsupported = errors.New("image metadata format is not implemented")

type generatedImageMetadata struct {
	path          string
	responsePaths []string
	mtime         float64
	metadata      orderedNodeJSON
}

func generateImageMetadata(filePath string, typeValue orderedNodeJSON, thumbnailDimensions map[string]any) (orderedNodeJSON, bool, error) {
	buffer, err := os.ReadFile(filePath)
	if err != nil {
		return orderedNodeJSON{}, false, err
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(buffer))
	if err != nil {
		if recognizedUnsupportedImageFormat(buffer) {
			return orderedNodeJSON{}, true, errImageMetadataFormatUnsupported
		}
		return orderedNodeJSON{}, false, err
	}
	if config.Width == 0 || config.Height == 0 {
		return orderedNodeJSON{}, false, errors.New("could not determine image dimensions")
	}

	fileStat, err := os.Stat(filePath)
	if err != nil {
		return orderedNodeJSON{}, false, err
	}
	mtime := nodeStatMtimeMilliseconds(fileStat.ModTime())
	addedTimestamp := math.Floor(mtime)
	if birthtime := nodeFileBirthtimeMilliseconds(filePath, fileStat); birthtime != 0 {
		addedTimestamp = math.Floor(birthtime)
	}

	isAnimated := false
	switch format {
	case "gif":
		isAnimated = true
	case "png":
		isAnimated = bytes.Contains(buffer[:min(len(buffer), 200)], []byte("acTL"))
	case "webp":
		header := buffer[:min(len(buffer), 200)]
		isAnimated = bytes.Contains(header, []byte("ANIM")) || bytes.Contains(header, []byte("ANMF"))
	}

	dominantColor := "#808080"
	if !isAnimated {
		if decoded, decodedFormat, decodeErr := image.Decode(bytes.NewReader(buffer)); decodeErr == nil && decodedFormat == format {
			dominantColor = jimpCompatibleAverageColor(decoded)
		}
	}

	hash := sha256.Sum256(buffer)
	aspectRatio := math.Round((float64(config.Width)/float64(config.Height))*10000) / 10000
	metadata := orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "hash", value: orderedNodeJSON{kind: 's', scalar: hex.EncodeToString(hash[:])}},
		{key: "aspectRatio", value: orderedNodeJSON{kind: 'v', scalar: aspectRatio}},
		{key: "isAnimated", value: orderedNodeJSON{kind: 'b', scalar: isAnimated}},
		{key: "dominantColor", value: orderedNodeJSON{kind: 's', scalar: dominantColor}},
		{key: "folderIds", value: orderedNodeJSON{kind: 'a'}},
		{key: "addedTimestamp", value: orderedNodeJSON{kind: 'v', scalar: addedTimestamp}},
		{key: "thumbnailResolution", value: orderedNodeJSON{kind: 'v', scalar: imageMetadataThumbnailResolution(typeValue, thumbnailDimensions)}},
	}}
	return metadata, false, nil
}

// jimpCompatibleAverageColor preserves fractional row averages until Jimp's final byte rounding.
func jimpCompatibleAverageColor(source image.Image) string {
	width := source.Bounds().Dx()
	height := source.Bounds().Dy()
	if width <= 0 || height <= 0 {
		return "#808080"
	}

	rowColors := make([][4]float64, height)
	for y := 0; y < height; y++ {
		var red, green, blue, alpha uint64
		var visiblePixels uint64
		for x := 0; x < width; x++ {
			pixel := color.NRGBAModel.Convert(source.At(source.Bounds().Min.X+x, source.Bounds().Min.Y+y)).(color.NRGBA)
			alpha += uint64(pixel.A)
			if pixel.A == 0 {
				continue
			}
			visiblePixels++
			red += uint64(pixel.R)
			green += uint64(pixel.G)
			blue += uint64(pixel.B)
		}
		row := [4]float64{0, 0, 0, float64(alpha) / float64(width)}
		if visiblePixels > 0 {
			row[0] = float64(red) / float64(visiblePixels)
			row[1] = float64(green) / float64(visiblePixels)
			row[2] = float64(blue) / float64(visiblePixels)
		}
		rowColors[y] = row
	}

	var red, green, blue float64
	var visibleRows uint64
	for _, row := range rowColors {
		if row[3] == 0 {
			continue
		}
		visibleRows++
		red += row[0]
		green += row[1]
		blue += row[2]
	}
	if visibleRows == 0 {
		return "#000000"
	}
	return fmt.Sprintf(
		"#%02x%02x%02x",
		uint8(math.Round(red/float64(visibleRows))),
		uint8(math.Round(green/float64(visibleRows))),
		uint8(math.Round(blue/float64(visibleRows))),
	)
}

func imageMetadataThumbnailResolution(typeValue orderedNodeJSON, configuredDimensions map[string]any) float64 {
	name, err := typeValue.javascriptString()
	if err != nil {
		return 0
	}
	defaultDimensions := map[string]any{
		"bg":      []any{160, 90},
		"avatar":  []any{96, 144},
		"persona": []any{96, 144},
	}
	if _, exists := defaultDimensions[name]; !exists {
		return 0
	}
	dimensions, exists := configuredDimensions[name]
	if !exists {
		dimensions = defaultDimensions[name]
	}
	values, isArray := imageMetadataDimensionArray(dimensions)
	if !isArray || len(values) < 2 {
		return 0
	}
	return imageMetadataJavaScriptNumber(values[0]) * imageMetadataJavaScriptNumber(values[1])
}

func imageMetadataDimensionArray(value any) ([]any, bool) {
	switch values := value.(type) {
	case []any:
		return values, true
	case []string:
		result := make([]any, len(values))
		for index, item := range values {
			result[index] = item
		}
		return result, true
	case []int:
		result := make([]any, len(values))
		for index, item := range values {
			result[index] = item
		}
		return result, true
	case []float64:
		result := make([]any, len(values))
		for index, item := range values {
			result[index] = item
		}
		return result, true
	default:
		return nil, false
	}
}

func imageMetadataJavaScriptNumber(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case bool:
		if typed {
			return 1
		}
		return 0
	case int:
		return float64(typed)
	case int8:
		return float64(typed)
	case int16:
		return float64(typed)
	case int32:
		return float64(typed)
	case int64:
		return float64(typed)
	case uint:
		return float64(typed)
	case uint8:
		return float64(typed)
	case uint16:
		return float64(typed)
	case uint32:
		return float64(typed)
	case uint64:
		return float64(typed)
	case float32:
		return float64(typed)
	case float64:
		return typed
	case string:
		return imageMetadataJavaScriptNumberString(typed)
	case []any:
		return imageMetadataJavaScriptNumberString(imageMetadataConfigArrayString(typed))
	case []string:
		return imageMetadataJavaScriptNumberString(strings.Join(typed, ","))
	default:
		return math.NaN()
	}
}

func imageMetadataConfigArrayString(values []any) string {
	parts := make([]string, len(values))
	for index, value := range values {
		if value == nil {
			continue
		}
		parts[index] = imageMetadataConfigString(value)
	}
	return strings.Join(parts, ",")
}

func imageMetadataConfigString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case int:
		return strconv.Itoa(typed)
	case int8:
		return strconv.FormatInt(int64(typed), 10)
	case int16:
		return strconv.FormatInt(int64(typed), 10)
	case int32:
		return strconv.FormatInt(int64(typed), 10)
	case int64:
		return strconv.FormatInt(typed, 10)
	case uint:
		return strconv.FormatUint(uint64(typed), 10)
	case uint8:
		return strconv.FormatUint(uint64(typed), 10)
	case uint16:
		return strconv.FormatUint(uint64(typed), 10)
	case uint32:
		return strconv.FormatUint(uint64(typed), 10)
	case uint64:
		return strconv.FormatUint(typed, 10)
	case float32:
		return javascriptNumberString(float64(typed))
	case float64:
		return javascriptNumberString(typed)
	case []any:
		return imageMetadataConfigArrayString(typed)
	case []string:
		return strings.Join(typed, ",")
	default:
		return "[object Object]"
	}
}

func imageMetadataJavaScriptNumberString(value string) float64 {
	trimmed := strings.TrimFunc(value, isECMAScriptNumberWhitespace)
	if trimmed == "" {
		return 0
	}
	if trimmed == "Infinity" || trimmed == "+Infinity" {
		return math.Inf(1)
	}
	if trimmed == "-Infinity" {
		return math.Inf(-1)
	}
	lower := strings.ToLower(trimmed)
	for _, prefix := range []struct {
		marker string
		base   int
	}{{"0x", 16}, {"0b", 2}, {"0o", 8}} {
		if strings.HasPrefix(lower, prefix.marker) {
			digits := trimmed[2:]
			if !imageMetadataValidRadixDigits(digits, prefix.base) {
				return math.NaN()
			}
			parsed, ok := new(big.Int).SetString(digits, prefix.base)
			if !ok {
				return math.NaN()
			}
			value, _ := new(big.Float).SetInt(parsed).Float64()
			return value
		}
	}
	parsed, parseErr := strconv.ParseFloat(trimmed, 64)
	if parseErr != nil {
		return math.NaN()
	}
	return parsed
}

func isECMAScriptNumberWhitespace(value rune) bool {
	switch value {
	case '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', '\u0020', '\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF':
		return true
	default:
		return value >= '\u2000' && value <= '\u200A'
	}
}

func imageMetadataValidRadixDigits(value string, base int) bool {
	if value == "" {
		return false
	}
	for _, digit := range value {
		var number int
		switch {
		case digit >= '0' && digit <= '9':
			number = int(digit - '0')
		case digit >= 'a' && digit <= 'f':
			number = int(digit-'a') + 10
		case digit >= 'A' && digit <= 'F':
			number = int(digit-'A') + 10
		default:
			return false
		}
		if number >= base {
			return false
		}
	}
	return true
}

func nodeStatMtimeMilliseconds(mtime time.Time) float64 {
	return float64(mtime.Unix())*1e3 + float64(mtime.Nanosecond())/1e6
}

func preserveImageMetadataFolderIDs(metadata, cached orderedNodeJSON) orderedNodeJSON {
	if !cached.truthy() {
		return metadata
	}
	folderIDs, exists := cached.member("folderIds")
	if exists && folderIDs.truthy() {
		metadata.setMember("folderIds", folderIDs)
	}
	return metadata
}

func imageMetadataAtPath(index orderedNodeJSON, relativePath string) (orderedNodeJSON, bool, bool) {
	if index.kind == 'n' {
		return orderedNodeJSON{}, false, true
	}
	images, hasImages := index.member("images")
	if !hasImages || images.kind == 'n' {
		return orderedNodeJSON{}, false, true
	}
	value, exists := images.member(relativePath)
	if !exists && images.kind == 'a' {
		if arrayIndex, ok := nodeArrayIndex(relativePath); ok && arrayIndex < uint64(len(images.array)) {
			value, exists = images.array[arrayIndex], true
		}
	}
	return value, exists, false
}

func setImageMetadataAtPath(index *orderedNodeJSON, relativePath string, metadata orderedNodeJSON) bool {
	images, hasImages := index.member("images")
	if !hasImages || images.kind != 'o' {
		return false
	}
	images.setMember(relativePath, metadata)
	index.setMember("images", images)
	return true
}

func persistGeneratedImageMetadata(dataRoot, handle string, pending []generatedImageMetadata) (map[string]orderedNodeJSON, error) {
	results := make(map[string]orderedNodeJSON, len(pending))
	if len(pending) == 0 {
		return results, nil
	}
	err := startup.UpdateUserContentFileIfChanged(dataRoot, handle, imageMetadataIndexFilename, func(current []byte) ([]byte, bool, error) {
		index := defaultImageMetadataIndex()
		if len(current) > 0 {
			if parsed, parseErr := decodeOrderedNodeJSON(current); parseErr == nil {
				index = parsed
			}
		}
		modified := false
		for _, update := range pending {
			cached, hasCached, cacheError := imageMetadataAtPath(index, update.path)
			if cacheError {
				return nil, false, errors.New("image metadata index has no usable images collection")
			}
			if hasCached && cached.truthy() {
				storedMtime, hasMtime := cached.member("mtime")
				if hasMtime && storedMtime.kind == 'v' && storedMtime.scalar.(float64) == update.mtime {
					results[update.path] = cached
					continue
				}
			}
			metadata := preserveImageMetadataFolderIDs(update.metadata, cached)
			metadata.setMember("mtime", orderedNodeJSON{kind: 'v', scalar: update.mtime})
			if !setImageMetadataAtPath(&index, update.path, metadata) {
				return nil, false, errors.New("image metadata index images collection is not an object")
			}
			results[update.path] = metadata
			modified = true
		}
		if !modified {
			return nil, false, nil
		}
		body, err := marshalPrettyOrderedNodeJSON(index, 0)
		return body, true, err
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

func recognizedUnsupportedImageFormat(data []byte) bool {
	if len(data) >= 2 && data[0] == 'B' && data[1] == 'M' {
		return true
	}
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		return true
	}
	if len(data) >= 4 && (bytes.Equal(data[:4], []byte{'I', 'I', 42, 0}) || bytes.Equal(data[:4], []byte{'M', 'M', 0, 42}) || bytes.Equal(data[:4], []byte{'I', 'I', 43, 0}) || bytes.Equal(data[:4], []byte{'M', 'M', 0, 43})) {
		return true
	}
	if len(data) >= 12 && string(data[4:8]) == "ftyp" {
		brands := string(data[8:min(len(data), 40)])
		if strings.Contains(brands, "avif") || strings.Contains(brands, "avis") || strings.Contains(brands, "heic") || strings.Contains(brands, "heix") || strings.Contains(brands, "jp2 ") {
			return true
		}
	}
	if len(data) >= 4 && bytes.Equal(data[:4], []byte{0xff, 0x4f, 0xff, 0x51}) {
		return true
	}
	if bytes.Contains(bytes.ToLower(data[:min(len(data), 512)]), []byte("<svg")) {
		return true
	}
	return false
}
