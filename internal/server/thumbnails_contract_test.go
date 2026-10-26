package server

// THE /thumbnail REPRODUCER (AGENTS.md 31, 44, 45, 46). It is RED today because this server registers
// no /thumbnail route at all, and it is written to fail for that reason and no other.
//
// WHY THIS ROUTE IS A P0 AND NOT A GAP: pinned public/script.js builds /thumbnail?type=<bg|avatar|
// persona>&file=<name> in getThumbnailUrl, which buildAvatarList calls for the character list and which
// group-chats.js, bookmarks.js, personas.js and backgrounds.js call for every avatar and background tile
// they render (AGENTS.md 44). The browser has no fallback, so with this route absent every one of those
// images is a broken image on a real user's page.
//
// PROVENANCE (rule 4): the observable list below is SOURCE-DERIVED from pinned
// src/endpoints/thumbnails.js (mounted app.use('/thumbnail', thumbnailRouter) in src/server-startup.js,
// GET-only, plus publicRouter.get('/') so both /thumbnail and /thumbnail/ answer), and each assertion
// names the pinned behaviour it reproduces. It is NOT a capture: the route needs a session and a data
// root that no route-level fixture carries, and the bytes are a codec decision recorded in
// ARCHITECTURE.md 35.2. So this asserts the OBSERVABLE -- status, MIME, decodability and dimensions --
// and never byte equality with Jimp.
//
// Type -> directory mapping is pinned (thumbnails.js getThumbnailFolder/getOriginalFolder):
//
//	avatar   originals <user>/characters     cache <user>/thumbnails/avatar
//	persona  originals <user>/User Avatars   cache <user>/thumbnails/persona
//	bg       originals <user>/backgrounds    cache <user>/thumbnails/bg
//
// Of the cases the contract has, `thumbnails.enabled=false` and the cache-regeneration pair (mtime vs
// ctime) need the config plumbing and the cache writer, so they land in the implementation commit
// rather than here; the four status branches and the two dimension branches are reachable today and
// they are what makes this red.

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeThumbnailSourcePNG plants an original of a known, non-square size so a cover/resize that
// silently does nothing is distinguishable from one that ran. The configured defaults are
// thumbnails.dimensions.avatar = [96,144] and .bg = [160,90] (internal/commandline/options.go:262-265).
const (
	thumbnailSourceWidth  = 400
	thumbnailSourceHeight = 300
)

func writeThumbnailSourcePNG(t *testing.T, path string) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, thumbnailSourceWidth, thumbnailSourceHeight))
	for y := 0; y < thumbnailSourceHeight; y++ {
		for x := 0; x < thumbnailSourceWidth; x++ {
			picture.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 128, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, picture); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buffer.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func decodeThumbnail(t *testing.T, body []byte) image.Image {
	t.Helper()
	decoded, format, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("/thumbnail body does not decode as an image (%v); the frontend puts this in an <img>", err)
	}
	if format == "" {
		t.Fatal("/thumbnail body decoded with an empty format")
	}
	return decoded
}

// TestPinnedThumbnailServesTheObservableContract is the gate. Every case names the pinned behaviour.
func TestPinnedThumbnailServesTheObservableContract(t *testing.T) {
	harness := newFrontendAssetHarness(t)
	userRoot := filepath.Join(harness.dataRoot, "default-user")

	avatarOriginal := filepath.Join(userRoot, "characters", "hero.png")
	writeThumbnailSourcePNG(t, avatarOriginal)
	backgroundOriginal := filepath.Join(userRoot, "backgrounds", "scene.png")
	writeThumbnailSourcePNG(t, backgroundOriginal)
	personaOriginal := filepath.Join(userRoot, "User Avatars", "me.png")
	writeThumbnailSourcePNG(t, personaOriginal)

	t.Run("avatar thumbnail decodes at the configured dimensions", func(t *testing.T) {
		response := harness.get(t, "/thumbnail?type=avatar&file=hero.png", true)
		if response.Code != http.StatusOK {
			t.Fatalf("GET /thumbnail?type=avatar&file=hero.png = %d, pinned answers 200 with a resized image; the character list and every chat avatar render this URL (body: %.120q)",
				response.Code, response.Body.String())
		}
		// The MIME comes from the ORIGINAL filename's extension, not from the encoded format
		// (pinned res.sendFile keeps the original name), so a .png original is served image/png.
		if got := response.Header().Get("Content-Type"); !strings.HasPrefix(got, "image/png") {
			t.Fatalf("Content-Type = %q, pinned serves the cached file under the original name, so a .png original is image/png", got)
		}
		decoded := decodeThumbnail(t, response.Body.Bytes())
		bounds := decoded.Bounds()
		// avatar uses COVER to exactly the configured size: 96x144.
		if bounds.Dx() != 96 || bounds.Dy() != 144 {
			t.Fatalf("avatar thumbnail is %dx%d, pinned covers to the configured [96,144] (thumbnails.dimensions.avatar)", bounds.Dx(), bounds.Dy())
		}
	})

	t.Run("the trailing-slash spelling answers too", func(t *testing.T) {
		// pinned mounts the router at '/thumbnail' and registers publicRouter.get('/'), so
		// /thumbnail/ is the same handler; the frontend builds the other spelling but a direct
		// navigation reaches this one.
		response := harness.get(t, "/thumbnail/?type=avatar&file=hero.png", true)
		if response.Code != http.StatusOK {
			t.Fatalf("GET /thumbnail/?type=avatar&file=hero.png = %d, pinned answers 200 (publicRouter.get('/') under app.use('/thumbnail'))", response.Code)
		}
	})

	t.Run("bg thumbnail is fitted, not covered", func(t *testing.T) {
		response := harness.get(t, "/thumbnail?type=bg&file=scene.png", true)
		if response.Code != http.StatusOK {
			t.Fatalf("GET /thumbnail?type=bg&file=scene.png = %d, pinned answers 200; backgrounds.js renders every gallery tile from this URL", response.Code)
		}
		decoded := decodeThumbnail(t, response.Body.Bytes())
		bounds := decoded.Bounds()
		// bg keeps the aspect ratio inside the configured area: 160x90 over a 4:3 source gives
		// round(sqrt(14400*4/3)) x round(sqrt(14400*3/4)) = 139 x 104.
		if bounds.Dx() != 139 || bounds.Dy() != 104 {
			t.Fatalf("bg thumbnail is %dx%d, pinned fits the configured 160x90 area to the source ratio (want 139x104 for a 4:3 original)", bounds.Dx(), bounds.Dy())
		}
	})

	t.Run("persona thumbnail uses its own directory and size", func(t *testing.T) {
		response := harness.get(t, "/thumbnail?type=persona&file=me.png", true)
		if response.Code != http.StatusOK {
			t.Fatalf("GET /thumbnail?type=persona&file=me.png = %d, pinned reads originals from <user>/User Avatars and answers 200; personas.js renders this", response.Code)
		}
		decoded := decodeThumbnail(t, response.Body.Bytes())
		bounds := decoded.Bounds()
		if bounds.Dx() != 96 || bounds.Dy() != 144 {
			t.Fatalf("persona thumbnail is %dx%d, pinned covers to the configured [96,144]", bounds.Dx(), bounds.Dy())
		}
	})

	t.Run("a repeated query key is a 400 because the value is not a string", func(t *testing.T) {
		// Express turns a repeated key into an array, pinned's typeof check rejects it, and the
		// REASON matters as much as the status: it is not a validation of the file name.
		response := harness.get(t, "/thumbnail?type=avatar&type=avatar&file=hero.png", true)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("repeated `type` = %d, pinned answers 400 because typeof value !== 'string''", response.Code)
		}
	})

	t.Run("an unknown type is a 400", func(t *testing.T) {
		response := harness.get(t, "/thumbnail?type=bogus&file=hero.png", true)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("type=bogus = %d, pinned answers 400 for a value outside {bg,avatar,persona}", response.Code)
		}
	})

	t.Run("a missing file parameter is a 400", func(t *testing.T) {
		response := harness.get(t, "/thumbnail?type=avatar", true)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("missing `file` = %d, pinned answers 400 (the same typeof !== 'string' guard)", response.Code)
		}
	})

	t.Run("a name sanitize-filename would change is a 403", func(t *testing.T) {
		// pinned: const sanitized = sanitize(rawFile); if (sanitized !== rawFile) return 403.
		// Real filenames include CJK, spaces and interior dots, and the comparison is an IDENTITY,
		// not a security hardening -- so `../hero.png` is refused as a mismatch, not as a traversal.
		response := harness.get(t, "/thumbnail?type=avatar&file=../hero.png", true)
		if response.Code != http.StatusForbidden {
			t.Fatalf("file=../hero.png = %d, pinned compares sanitize(raw) with raw and answers 403 on any mismatch", response.Code)
		}
	})

	t.Run("a missing original is a 404", func(t *testing.T) {
		response := harness.get(t, "/thumbnail?type=avatar&file=absent.png", true)
		if response.Code != http.StatusNotFound {
			t.Fatalf("file=absent.png = %d, pinned answers 404 when the original does not exist", response.Code)
		}
	})

	t.Run("an animated extension serves the original bytes verbatim", func(t *testing.T) {
		// A .gif is short-circuited before the cache check, so it is never resized; the same holds
		// for any extension in SKIPPED_EXTENSIONS with animated=true.
		gifBytes := []byte("GIF89a-not-really-a-gif-but-byte-identical-to-what-was-planted")
		if err := os.WriteFile(filepath.Join(userRoot, "characters", "dance.gif"), gifBytes, 0o600); err != nil {
			t.Fatal(err)
		}
		response := harness.get(t, "/thumbnail?type=avatar&file=dance.gif", true)
		if response.Code != http.StatusOK {
			t.Fatalf("GET /thumbnail?type=avatar&file=dance.gif = %d, pinned serves the original (200)", response.Code)
		}
		if !bytes.Equal(response.Body.Bytes(), gifBytes) {
			t.Fatalf("a .gif must be served BYTE-IDENTICAL (it is short-circuited before any re-encode), got %d bytes", response.Body.Len())
		}
	})
}
