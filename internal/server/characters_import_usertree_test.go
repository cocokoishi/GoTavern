package server

// The USER-TREE half of the characters/import oracle: the three archive formats
// and the RisuAI sprite path write files outside the top-level characters
// directory (sprite folders, BYAF chats, BYAF backgrounds, alternate icons), and
// "the card was stored" does not prove any of those. This file rebuilds the same
// snapshot the probe records and reports the first differing entry by path.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

type charactersUserTreeSample struct {
	X    int    `json:"x"`
	Y    int    `json:"y"`
	RGBA [4]int `json:"rgba"`
}

type charactersUserTreeEntry struct {
	Path      string                     `json:"path"`
	Kind      string                     `json:"kind"`
	CharaJSON *string                    `json:"charaJSON,omitempty"`
	Width     *int                       `json:"width,omitempty"`
	Height    *int                       `json:"height,omitempty"`
	Digest    *string                    `json:"digest,omitempty"`
	Samples   []charactersUserTreeSample `json:"samples,omitempty"`
	SHA256    *string                    `json:"sha256,omitempty"`
	Bytes     *int                       `json:"bytes,omitempty"`
	Text      *string                    `json:"text,omitempty"`
}

var (
	generatedISO         = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`)
	userTreeCardPath     = regexp.MustCompile(`^characters/[^/]+\.png$`)
	userTreeSamplePoints = [][2]int{{0, 0}, {1, 1}, {30, 384}, {256, 384}}
)

// normalizeGeneratedText mirrors the probe's normalization of values a clock
// produced: the humanized chat name and every generated ISO timestamp.
func normalizeGeneratedText(text string) string {
	normalized := humanizedDateTimePattern.ReplaceAllString(text, "<humanizedDateTime>")
	return generatedISO.ReplaceAllString(normalized, "<isoDate>")
}

// assertImportUserTree compares the whole user tree the import formats touch.
func assertImportUserTree(t *testing.T, label string, env *charactersOracleEnv, omitDigestFor []string, want []charactersUserTreeEntry) {
	t.Helper()
	if want == nil {
		return
	}
	got := charactersUserTreeSnapshot(t, env, omitDigestFor)
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("%s user tree snapshot could not be encoded: %v", label, err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("%s user tree fixture could not be encoded: %v", label, err)
	}
	if string(gotJSON) == string(wantJSON) {
		return
	}
	// Name the FIRST differing path instead of printing two whole trees.
	gotByPath := make(map[string]charactersUserTreeEntry, len(got))
	for _, entry := range got {
		gotByPath[entry.Path] = entry
	}
	wantByPath := make(map[string]charactersUserTreeEntry, len(want))
	for _, entry := range want {
		wantByPath[entry.Path] = entry
	}
	for _, expected := range want {
		actual, exists := gotByPath[expected.Path]
		if !exists {
			t.Fatalf("%s user tree is missing %s (kind %s); pinned Node wrote it", label, expected.Path, expected.Kind)
		}
		expectedJSON, _ := json.Marshal(expected)
		actualJSON, _ := json.Marshal(actual)
		if string(expectedJSON) != string(actualJSON) {
			t.Fatalf("%s user tree entry %s differs from the pinned oracle (omitDigestFor=%v):\n got: %s\nwant: %s", label, expected.Path, omitDigestFor, actualJSON, expectedJSON)
		}
		delete(gotByPath, expected.Path)
	}
	for path := range gotByPath {
		t.Fatalf("%s user tree has an extra entry %s; pinned Node did not write it", label, path)
	}
	t.Fatalf("%s user tree differs from the pinned oracle (%d vs %d entries)", label, len(got), len(want))
}

func charactersUserTreeSnapshot(t *testing.T, env *charactersOracleEnv, omitDigestFor []string) []charactersUserTreeEntry {
	t.Helper()
	type collected struct {
		fullPath string
		relative string
	}
	files := make([]collected, 0, 32)
	collect := func(root, prefix string) {
		_ = filepath.WalkDir(root, func(fullPath string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			relative, relErr := filepath.Rel(root, fullPath)
			if relErr != nil {
				return nil
			}
			files = append(files, collected{fullPath: fullPath, relative: prefix + "/" + filepath.ToSlash(relative)})
			return nil
		})
	}
	userRoot := env.Directories["root"]
	collect(env.Directories["characters"], "characters")
	collect(env.Directories["chats"], "chats")
	collect(env.Directories["userImages"], "user/images")
	_ = userRoot

	entries := make([]charactersUserTreeEntry, 0, len(files))
	omit := make(map[string]bool, len(omitDigestFor))
	for _, name := range omitDigestFor {
		omit[name] = true
	}
	for _, file := range files {
		body, err := os.ReadFile(file.fullPath)
		if err != nil {
			t.Fatalf("could not read %s: %v", file.fullPath, err)
		}
		entry := charactersUserTreeEntry{Path: normalizeGeneratedText(file.relative)}
		if userTreeCardPath.MatchString(file.relative) {
			entry.Kind = "card"
			if text, textErr := readPngCardText(body); textErr == nil {
				normalized := normalizeGeneratedText(normalizeWrittenCardText(text, true))
				entry.CharaJSON = &normalized
			}
			if width, height, pixels, ok := decodeCardPixels(body); ok {
				entry.Width = &width
				entry.Height = &height
				if !omit[filepath.Base(file.fullPath)] {
					digest := sha256.Sum256(pixels)
					digestHex := hex.EncodeToString(digest[:])
					entry.Digest = &digestHex
				}
				samples := make([]charactersUserTreeSample, 0, len(userTreeSamplePoints))
				for _, point := range userTreeSamplePoints {
					x := point[0]
					y := point[1]
					if x > width-1 {
						x = width - 1
					}
					if y > height-1 {
						y = height - 1
					}
					offset := (y*width + x) * 4
					samples = append(samples, charactersUserTreeSample{
						X: x, Y: y,
						RGBA: [4]int{int(pixels[offset]), int(pixels[offset+1]), int(pixels[offset+2]), int(pixels[offset+3])},
					})
				}
				entry.Samples = samples
			}
			entries = append(entries, entry)
			continue
		}
		if strings.HasSuffix(file.relative, ".jsonl") {
			text := normalizeGeneratedText(string(body))
			entry.Kind = "jsonl"
			entry.Text = &text
			entries = append(entries, entry)
			continue
		}
		digest := sha256.Sum256(body)
		digestHex := hex.EncodeToString(digest[:])
		length := len(body)
		entry.Kind = "file"
		entry.SHA256 = &digestHex
		entry.Bytes = &length
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Path < entries[right].Path })
	return entries
}

// decodeCardPixels returns the RGBA bytes the probe records: pngjs decodes to
// straight RGBA, and NRGBA conversion is the same representation for the opaque
// PNGs these routes store.
func decodeCardPixels(body []byte) (int, int, []byte, bool) {
	decoded, err := png.Decode(strings.NewReader(string(body)))
	if err != nil {
		return 0, 0, nil, false
	}
	bounds := decoded.Bounds()
	target := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	draw.Draw(target, target.Bounds(), decoded, bounds.Min, draw.Src)
	return bounds.Dx(), bounds.Dy(), target.Pix, true
}

var _ = fmt.Sprintf
