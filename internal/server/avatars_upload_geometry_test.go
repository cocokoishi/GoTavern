package server

// THE AVATAR-UPLOAD GEOMETRY, ASSERTED WHERE A DIMENSION-ONLY CHECK CANNOT SEE IT.
//
// The existing tests pin the output SIZE for the no-crop and crop branches (original dimensions, and
// crop.width x crop.height). Size alone cannot distinguish the two things `applyAvatarCropResize` actually
// does, and both are user-visible:
//
//   - `want_resize` must produce the pinned AVATAR_WIDTH x AVATAR_HEIGHT box (512x768, src/constants.js:358),
//     which no test asserted;
//   - `cover` is SCALE-TO-COVER-THEN-CENTRE-CROP, not a stretch. A stretch produces the same dimensions, so a
//     size assertion passes for both while the picture is wrong. The discriminator below puts content OUTSIDE
//     the cover box: under cover it is cropped away and cannot appear; under a stretch it would be visible.
//
// The output format is part of the contract too: pinned calls `image.getBuffer(JimpMime.png)`, so the stored
// file is a PNG regardless of what was uploaded.

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// markedAvatarPNG builds a fixture whose pixels are decided by the caller, so an assertion can talk about
// WHICH PIXEL ended up where rather than only about dimensions. PNG is lossless, so a colour survives the
// round trip.
func markedAvatarPNG(t *testing.T, width, height int, mark func(x, y int) color.RGBA) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			canvas.Set(x, y, mark(x, y))
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, canvas); err != nil {
		t.Fatalf("encode fixture png: %v", err)
	}
	return encoded.Bytes()
}

// TestPersonaAvatarUploadWantResizeProducesThePinnedAvatarBox covers the branch the pinned frontend takes
// whenever it hands the server a crop box: `crop.want_resize` replaces the crop's own dimensions with
// AVATAR_WIDTH x AVATAR_HEIGHT (characters.js:295-297), and the cover then fills that box.
func TestPersonaAvatarUploadWantResizeProducesThePinnedAvatarBox(t *testing.T) {
	harness := newPersonaAvatarUploadHarness(t)
	body := avatarUploadPNG(t, 40, 30)
	crop := url.QueryEscape(`{"x":0,"y":0,"width":20,"height":15,"want_resize":true}`)

	response := harness.uploadAvatar(t, "crop="+crop, body, "source.png", "resized.png")
	if response.Code != 200 {
		t.Fatalf("upload = %d, body %q", response.Code, response.Body.String())
	}
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode the response: %v", err)
	}
	stored := filepath.Join(harness.avatarsDirectory, payload.Path)
	width, height := storedImageDimensions(t, stored)
	if width != avatarWidth || height != avatarHeight {
		t.Fatalf("stored avatar = %dx%d, want the pinned avatar box %dx%d (src/constants.js:358-359 AVATAR_WIDTH/AVATAR_HEIGHT via characters.js:295-297)",
			width, height, avatarWidth, avatarHeight)
	}
}

// TestPersonaAvatarUploadStoresAPNGWhateverWasUploaded pins the encoder choice: pinned writes
// `getBuffer(JimpMime.png)` (characters.js:305), so an uploaded JPEG becomes a PNG on disk, and every consumer
// downstream (the frontend's <img>, the thumbnail route, a hand-back to Node) sees PNG bytes.
func TestPersonaAvatarUploadStoresAPNGWhateverWasUploaded(t *testing.T) {
	harness := newPersonaAvatarUploadHarness(t)
	// A JPEG upload, so "the stored bytes are PNG" is not satisfied by the input already being PNG.
	jpegSource := jpegFixture(t, 24, 18)
	response := harness.uploadAvatar(t, "", jpegSource, "source.jpg", "converted.png")
	if response.Code != 200 {
		t.Fatalf("upload = %d, body %q", response.Code, response.Body.String())
	}
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode the response: %v", err)
	}
	if payload.Path != "converted.png" {
		t.Fatalf("stored filename = %q, want the exact overwrite_name %q (avatars.js:56 sanitizes but does not rename or re-extension)", payload.Path, "converted.png")
	}
	stored, err := os.ReadFile(filepath.Join(harness.avatarsDirectory, payload.Path))
	if err != nil {
		t.Fatalf("read the stored avatar: %v", err)
	}
	pngSignature := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}
	if !bytes.HasPrefix(stored, pngSignature) {
		t.Fatalf("the stored avatar is not a PNG (first bytes % x); pinned encodes with JimpMime.png", stored[:min(8, len(stored))])
	}
	// And it still decodes as an image, which a mis-labelled file would not.
	if width, height := storedImageDimensions(t, filepath.Join(harness.avatarsDirectory, payload.Path)); width <= 0 || height <= 0 {
		t.Fatalf("the stored PNG does not decode to a non-empty image (%dx%d)", width, height)
	}
}

// TestPersonaAvatarUploadCoversInsteadOfStretching is the discriminator the dimension assertions cannot be.
//
// THE FIXTURE: a 200x100 image whose 10-pixel side borders are BLACK and whose interior is RED. `want_resize`
// asks for 512x768, so `cover` scales by max(512/200, 768/100) = 7.68 to 1536x768 and then centre-crops the
// middle 512 columns -- source x 66.7 .. 133.3, comfortably inside the red interior. The black borders are
// therefore OUTSIDE the visible box and cannot appear in the output.
//
// A STRETCH (resize 200x100 -> 512x768) produces the same dimensions and would paint the borders as ~25-pixel
// black bars at both edges, which is what this asserts against: the leftmost and rightmost columns must be the
// interior colour.
func TestPersonaAvatarUploadCoversInsteadOfStretching(t *testing.T) {
	harness := newPersonaAvatarUploadHarness(t)
	const (
		width        = 200
		height       = 100
		border       = 10
		interiorRed  = 0xC0
		interiorBlue = 0x10
	)
	fixture := markedAvatarPNG(t, width, height, func(x, y int) color.RGBA {
		if x < border || x >= width-border {
			return color.RGBA{A: 255} // black border
		}
		return color.RGBA{R: interiorRed, G: 0, B: interiorBlue, A: 255}
	})
	crop := url.QueryEscape(`{"x":0,"y":0,"width":200,"height":100,"want_resize":true}`)
	response := harness.uploadAvatar(t, "crop="+crop, fixture, "source.png", "covered.png")
	if response.Code != 200 {
		t.Fatalf("upload = %d, body %q", response.Code, response.Body.String())
	}
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode the response: %v", err)
	}
	stored, err := os.ReadFile(filepath.Join(harness.avatarsDirectory, payload.Path))
	if err != nil {
		t.Fatalf("read the stored avatar: %v", err)
	}
	decoded, err := png.Decode(bytes.NewReader(stored))
	if err != nil {
		t.Fatalf("decode the stored avatar: %v", err)
	}
	bounds := decoded.Bounds()
	if bounds.Dx() != avatarWidth || bounds.Dy() != avatarHeight {
		t.Fatalf("stored avatar = %dx%d, want %dx%d", bounds.Dx(), bounds.Dy(), avatarWidth, avatarHeight)
	}
	// The outermost columns come from the red interior under `cover`. Under a stretch they would be the black
	// border, so this single comparison is what tells the two implementations apart.
	for _, x := range []int{bounds.Min.X, bounds.Max.X - 1} {
		for _, y := range []int{bounds.Min.Y + bounds.Dy()/4, bounds.Min.Y + bounds.Dy()/2, bounds.Min.Y + 3*bounds.Dy()/4} {
			r, g, b, _ := decoded.At(x, y).RGBA()
			if r < 0x7F00 && g < 0x7F00 && b < 0x7F00 {
				t.Fatalf("pixel (%d,%d) is black (%d,%d,%d): the outer border of the source is VISIBLE, so the image was STRETCHED instead of cover-cropped (characters.js:304 -> Jimp cover)", x, y, r>>8, g>>8, b>>8)
			}
		}
	}
	// And the interior colour is still the interior colour: a cover that scaled from black would fail above,
	// but a cover that painted a constant would fail here.
	r, _, b, _ := decoded.At(bounds.Dx()/2, bounds.Dy()/2).RGBA()
	if r>>8 < 0x50 || b>>8 > 0x80 {
		t.Fatalf("the centre pixel is (%d,0,%d), which is not the source's interior colour: the image was not resampled from the source", r>>8, b>>8)
	}
}

// jpegFixture is a real JPEG, so the "stored bytes are PNG" assertion cannot be satisfied by the input
// already being a PNG.
func jpegFixture(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			canvas.Set(x, y, color.RGBA{R: uint8(x * 7), G: uint8(y * 9), B: 120, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, canvas, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatalf("encode fixture jpeg: %v", err)
	}
	return encoded.Bytes()
}
