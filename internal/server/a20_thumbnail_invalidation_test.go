package server

// alpha.20 source-audit reproducer: image-mutation routes do not invalidate the generated thumbnail, so a
// user keeps seeing the OLD picture after replacing it.
//
// PINNED CONTRACT (src/endpoints/thumbnails.js:83-92): `invalidateThumbnail(directories, type, file)`
// unlinks the cached thumbnail, and pinned calls it from every route that replaces or removes an image:
//
//	src/endpoints/backgrounds.js:85   POST /api/backgrounds/delete
//	src/endpoints/backgrounds.js:119  POST /api/backgrounds/rename  (old name)
//	src/endpoints/backgrounds.js:143  POST /api/backgrounds/upload
//	src/endpoints/characters.js:1127  POST /api/characters/edit         (only when a file was uploaded)
//	src/endpoints/characters.js:1174  POST /api/characters/edit-avatar
//	src/endpoints/characters.js:1432  POST /api/characters/delete
//	src/endpoints/characters.js:1591  POST /api/characters/import
//	src/endpoints/avatars.js:25-35    POST /api/avatars/delete
//	src/endpoints/avatars.js:34,52    POST /api/avatars/upload (persona)
//
// GoTavern's /thumbnail serves the cached file whenever one EXISTS (thumbnails.go branch 8) and only two
// sites delete a cached thumbnail today (character import, persona upload/overwrite). So re-uploading a
// background under the same name, or replacing a character's avatar image, leaves the old thumbnail on
// disk and /thumbnail keeps serving the old picture: the character list, every chat message avatar, the
// background gallery and the persona list render the previous image indefinitely.
//
// The global cache buster (Clear-Site-Data / cache busting) does not help: it is a BROWSER-cache
// mechanism, and the stale bytes are on the SERVER (pinned therefore does both).

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// a20SolidPNG encodes a solid-colour PNG, the image body the routes store.
func a20SolidPNG(t *testing.T, width, height int, fill color.RGBA) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		for y := 0; y < height; y++ {
			canvas.SetRGBA(x, y, fill)
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, canvas); err != nil {
		t.Fatalf("encode fixture png: %v", err)
	}
	return buffer.Bytes()
}

// a20CardPNG builds a card PNG: the given image plus a `chara` tEXt chunk, which is what
// readPngCardText reads and what /thumbnail?type=avatar renders.
func a20CardPNG(t *testing.T, imageBody []byte, cardJSON string) []byte {
	t.Helper()
	chunks, err := extractPngChunks(imageBody)
	if err != nil {
		t.Fatalf("extract fixture png: %v", err)
	}
	text := pngChunk{name: "tEXt", data: []byte("chara\x00" + base64.StdEncoding.EncodeToString([]byte(cardJSON)))}
	withText := make([]pngChunk, 0, len(chunks)+1)
	withText = append(withText, chunks[:len(chunks)-1]...)
	withText = append(withText, text, chunks[len(chunks)-1])
	return encodePngChunks(withText)
}

// a20MultipartRequest builds a multipart body with text fields plus at most one file part.
func a20MultipartRequest(t *testing.T, fields map[string]string, fileField, fileName string, fileBody []byte) (string, string) {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatalf("write field %s: %v", name, err)
		}
	}
	if fileField != "" {
		part, err := writer.CreateFormFile(fileField, fileName)
		if err != nil {
			t.Fatalf("create file part: %v", err)
		}
		if _, err := part.Write(fileBody); err != nil {
			t.Fatalf("write file part: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return writer.FormDataContentType(), buffer.String()
}

// a20ThumbnailCenter fetches /thumbnail and returns the decoded centre pixel, which for a solid-colour
// source identifies WHICH image the server rendered.
func a20ThumbnailCenter(t *testing.T, env *charactersOracleEnv, thumbnailType, file string) color.RGBA {
	t.Helper()
	response := env.serve(t, http.MethodGet, "/thumbnail?type="+thumbnailType+"&file="+url.QueryEscape(file), "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET /thumbnail?type=%s&file=%s = %d body %q", thumbnailType, file, response.Code, response.Body.String())
	}
	decoded, _, err := image.Decode(bytes.NewReader(response.Body.Bytes()))
	if err != nil {
		t.Fatalf("decode thumbnail for %s: %v", file, err)
	}
	bounds := decoded.Bounds()
	red, green, blue, _ := decoded.At(bounds.Min.X+bounds.Dx()/2, bounds.Min.Y+bounds.Dy()/2).RGBA()
	return color.RGBA{R: uint8(red >> 8), G: uint8(green >> 8), B: uint8(blue >> 8), A: 255}
}

func a20AssertDominantColour(t *testing.T, label string, got color.RGBA, channel string) {
	t.Helper()
	switch channel {
	case "red":
		if !(got.R > 150 && got.G < 110 && got.B < 110) {
			t.Fatalf("%s: thumbnail centre = %+v, want the RED image; the server is serving a stale cached thumbnail", label, got)
		}
	case "blue":
		if !(got.B > 150 && got.R < 110 && got.G < 110) {
			t.Fatalf("%s: thumbnail centre = %+v, want the BLUE image; the server is serving a stale cached thumbnail (pinned invalidates it in the route, thumbnails.js:83-92)", label, got)
		}
	}
}

// TestA20BackgroundReuploadRefreshesThumbnail is the primary reproducer: upload a red background, render
// its thumbnail, re-upload a BLUE image under the same filename, render again. The second render must be
// blue; pinned unlinks the cached thumbnail in POST /api/backgrounds/upload (backgrounds.js:143).
func TestA20BackgroundReuploadRefreshesThumbnail(t *testing.T) {
	env := newCharactersOracleEnv(t, "a20-thumbnail-cookie")
	const name = "a20-bg.png"
	cachePath := filepath.Join(env.Directories["thumbnailsBg"], name)

	red := a20SolidPNG(t, 32, 32, color.RGBA{R: 220, G: 30, B: 30, A: 255})
	contentType, body := a20MultipartRequest(t, nil, "avatar", name, red)
	response := env.serve(t, http.MethodPost, "/api/backgrounds/upload", contentType, body)
	if response.Code != http.StatusOK {
		t.Fatalf("first upload = %d body %q", response.Code, response.Body.String())
	}
	a20AssertDominantColour(t, "first background", a20ThumbnailCenter(t, env, "bg", name), "red")
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("the first render did not create the thumbnail cache at %s: %v", cachePath, err)
	}

	blue := a20SolidPNG(t, 32, 32, color.RGBA{R: 30, G: 30, B: 220, A: 255})
	contentType, body = a20MultipartRequest(t, nil, "avatar", name, blue)
	response = env.serve(t, http.MethodPost, "/api/backgrounds/upload", contentType, body)
	if response.Code != http.StatusOK {
		t.Fatalf("re-upload = %d body %q", response.Code, response.Body.String())
	}
	a20AssertDominantColour(t, "re-uploaded background", a20ThumbnailCenter(t, env, "bg", name), "blue")
}

// TestA20CharacterDeleteRemovesTheCachedAvatarThumbnail covers the recycled-name case: a character is
// deleted and a NEW card is created under the same name. Pinned unlinks the thumbnail on delete
// (characters.js:1432), so the new card's render must be the new picture; without invalidation the old
// cached thumbnail still answers for the new character.
func TestA20CharacterDeleteRemovesTheCachedAvatarThumbnail(t *testing.T) {
	env := newCharactersOracleEnv(t, "a20-thumbnail-cookie")
	const name = "A20 Recycled.png"
	charactersRoot := env.Directories["characters"]
	if err := os.MkdirAll(charactersRoot, 0o777); err != nil {
		t.Fatalf("create characters dir: %v", err)
	}
	cardJSON := `{"name":"A20 Recycled","description":"x","data":{"name":"A20 Recycled"}}`
	redCard := a20CardPNG(t, a20SolidPNG(t, 32, 32, color.RGBA{R: 220, G: 30, B: 30, A: 255}), cardJSON)
	if err := os.WriteFile(filepath.Join(charactersRoot, name), redCard, 0o644); err != nil {
		t.Fatalf("write card: %v", err)
	}
	a20AssertDominantColour(t, "card before delete", a20ThumbnailCenter(t, env, "avatar", name), "red")

	contentType, body := a20MultipartRequest(t, map[string]string{"avatar_url": name}, "", "", nil)
	response := env.serve(t, http.MethodPost, "/api/characters/delete", contentType, body)
	if response.Code != http.StatusOK {
		t.Fatalf("delete = %d body %q", response.Code, response.Body.String())
	}
	blueCard := a20CardPNG(t, a20SolidPNG(t, 32, 32, color.RGBA{R: 30, G: 30, B: 220, A: 255}), cardJSON)
	if err := os.WriteFile(filepath.Join(charactersRoot, name), blueCard, 0o644); err != nil {
		t.Fatalf("write recycled card: %v", err)
	}
	a20AssertDominantColour(t, "recycled-name card", a20ThumbnailCenter(t, env, "avatar", name), "blue")
}

// TestA20CharacterAvatarEditRefreshesThumbnail is the character half: a card whose avatar is red, then
// POST /api/characters/edit-avatar uploads a blue picture. Pinned unlinks the avatar thumbnail in that
// route (characters.js:1174), so a fresh render must be blue.
func TestA20CharacterAvatarEditRefreshesThumbnail(t *testing.T) {
	env := newCharactersOracleEnv(t, "a20-thumbnail-cookie")
	const name = "A20 Avatar.png"
	charactersRoot := env.Directories["characters"]
	if err := os.MkdirAll(charactersRoot, 0o777); err != nil {
		t.Fatalf("create characters dir: %v", err)
	}
	cardJSON := `{"name":"A20 Avatar","description":"x","data":{"name":"A20 Avatar"}}`
	redCard := a20CardPNG(t, a20SolidPNG(t, 32, 32, color.RGBA{R: 220, G: 30, B: 30, A: 255}), cardJSON)
	if err := os.WriteFile(filepath.Join(charactersRoot, name), redCard, 0o644); err != nil {
		t.Fatalf("write card: %v", err)
	}
	a20AssertDominantColour(t, "card before edit", a20ThumbnailCenter(t, env, "avatar", name), "red")

	blue := a20SolidPNG(t, 32, 32, color.RGBA{R: 30, G: 30, B: 220, A: 255})
	contentType, body := a20MultipartRequest(t, map[string]string{"avatar_url": name}, "avatar", "upload.png", blue)
	response := env.serve(t, http.MethodPost, "/api/characters/edit-avatar", contentType, body)
	if response.Code != http.StatusOK {
		t.Fatalf("edit-avatar = %d body %q", response.Code, response.Body.String())
	}
	a20AssertDominantColour(t, "card after edit", a20ThumbnailCenter(t, env, "avatar", name), "blue")
}
