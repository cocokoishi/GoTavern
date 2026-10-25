package server

// POST /api/avatars/upload — the route that makes a persona avatar CREATABLE.
//
// Pinned `src/endpoints/avatars.js:41-65` is the contract. Two of its properties shape everything below:
//
//  1. multer is mounted APP-GLOBALLY (`src/server-main.js:269`:
//     `multer({dest: uploadsPath, limits: {fieldSize: 500*1024*1024}}).single('avatar')`), so the temp
//     file exists before the route's own middleware runs and the multipart field is literally `avatar`.
//     There is NO fileSize cap: the pinned server accepts an arbitrarily large upload. We stream the part
//     to disk rather than buffering it, and we do not invent a cap that would change behaviour.
//  2. `getFileNameValidationFunction('overwrite_name')` (`src/middleware/validateFileName.js:19-41`) runs
//     BEFORE the handler and refuses `/`, NUL and (on Windows) `\` with a bare 400. It deliberately does
//     NOT refuse `..`, which only `sanitize-filename` deals with. So a name can hit two different
//     branches and the comment at each check below says which one it is.
//
// The image work follows `applyAvatarCropResize` (`src/endpoints/characters.js:283-306`): crop only when
// x/y/width/height are all numbers; final size 512x768 when `want_resize` (`src/constants.js:358-359`),
// otherwise exactly the crop's width and height; then `cover` to that size. Per `ARCHITECTURE.md` §35.2
// the stored bytes are a pure-Go re-encode and only the OBSERVABLE has to match: valid image, right
// dimensions, right location. That divergence is declared in the compat row, not hidden here.

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	xdraw "golang.org/x/image/draw"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedAvatarWidth / pinnedAvatarHeight are AVATAR_WIDTH / AVATAR_HEIGHT (src/constants.js:358-359).
const (
	pinnedAvatarWidth  = 512
	pinnedAvatarHeight = 768
)

// errAvatarUploadMissing means "there was no multipart file", which pinned answers with 400 rather than
// treating as a server fault.
var errAvatarUploadMissing = errors.New("avatar upload is missing")

func (runtime *accountRuntime) serveAvatarsUpload(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}

	// The staging file is removed on success only (avatars.js:59). On a refusal pinned leaves multer's temp
	// file behind, and so do we -- an inherited leave-behind recorded in the compat row rather than a
	// cleanup invented here.
	stagedPath, fieldText, parseErr := parseAvatarMultipartUpload(request, runtime.options.DataRoot)
	if parseErr != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	// validateFileName.js:28-35 — the forbidden-character branch. This is NOT the sanitizer branch: a name
	// like `../x.png` contains `/` and is refused here with 400 before anything is written.
	overwriteName := fieldText["overwrite_name"]
	if filenameFieldHasForbiddenPathCharacters(overwriteName) {
		_ = os.Remove(stagedPath)
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	raw, readErr := os.ReadFile(stagedPath)
	if readErr != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	crop, hasCrop := parseAvatarCrop(request.URL.Query().Get("crop"))
	encoded, imageErr := pinnedAvatarCropResize(raw, crop, hasCrop)
	if imageErr != nil {
		// avatars.js:61-63 — the catch branch, with the pinned literal body.
		_ = os.Remove(stagedPath)
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Is not a valid image")
		return
	}

	// avatars.js:51-54 — invalidate the persona thumbnail and bust the cache on an overwrite, BEFORE the
	// write. The invalidation is the disk-observable half; `cacheBuster.bust` sets its header only when
	// `cacheBuster.enabled` is true, and that config defaults to FALSE (src/middleware/cacheBuster.js:28),
	// so with the default config the header is correctly absent.
	if overwriteName != "" {
		invalidatePersonaThumbnail(runtime.options.DataRoot, account.string("handle"), startup.SanitizeUserFilename(overwriteName))
	}
	// cacheBuster.bust sets Clear-Site-Data: "cache" ONLY when cacheBuster.enabled is true, and that
	// config defaults to FALSE (src/middleware/cacheBuster.js:28), so with the shipped default the header
	// is correctly absent and this route does not emit it. Wiring the config to a header is a separate
	// change with its own gate; the row records both halves.

	// avatars.js:56 — `sanitize(overwrite_name || `${Date.now()}.png`)`. The `..`-style names that survived
	// the forbidden-character check are collapsed HERE, which is why the two branches must stay distinct.
	filename := startup.SanitizeUserFilename(overwriteName)
	if filename == "" {
		filename = strconv.FormatInt(time.Now().UnixMilli(), 10) + ".png"
	}

	directories, dirErr := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if dirErr != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	target := filepath.Join(directories["avatars"], filename)
	if writeErr := startup.WriteFileAtomic(target, encoded); writeErr != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	_ = os.Remove(stagedPath)
	respondJSON(w, http.StatusOK, map[string]string{"path": filename})
}

// parseAvatarMultipartUpload streams the multipart body to a staging file, exactly as the backgrounds
// route does. The file part must be named `avatar` (the pinned global multer field) and the text fields
// are returned for the handler. The body is never buffered in memory, because pinned imposes no file size
// limit and a cap here would be a silent behaviour change.
func parseAvatarMultipartUpload(request *http.Request, dataRoot string) (string, map[string]string, error) {
	reader, err := request.MultipartReader()
	if err != nil {
		return "", nil, err
	}
	stagedPath := ""
	fields := make(map[string]string)
	cleanup := func() {
		if stagedPath != "" {
			_ = os.Remove(stagedPath)
		}
	}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			cleanup()
			return "", nil, err
		}
		if fileName := part.FileName(); fileName != "" {
			if part.FormName() != "avatar" || stagedPath != "" {
				_ = part.Close()
				cleanup()
				return "", nil, errors.New("unexpected multipart file field")
			}
			staged, createErr := startup.CreateUploadStagingFile(dataRoot)
			if createErr != nil {
				_ = part.Close()
				cleanup()
				return "", nil, createErr
			}
			stagedPath = staged.Name()
			_, copyErr := io.Copy(staged, part)
			partCloseErr := part.Close()
			stagedCloseErr := staged.Close()
			if copyErr != nil || partCloseErr != nil || stagedCloseErr != nil {
				cleanup()
				return "", nil, errors.New("copy multipart file")
			}
			continue
		}
		value, readErr := io.ReadAll(io.LimitReader(part, int64(pinnedUploadFieldSizeLimit)+1))
		partCloseErr := part.Close()
		if readErr != nil || partCloseErr != nil || int64(len(value)) > int64(pinnedUploadFieldSizeLimit) {
			cleanup()
			return "", nil, errors.New("read multipart field")
		}
		fields[part.FormName()] = string(value)
	}
	if stagedPath == "" {
		return "", nil, errAvatarUploadMissing
	}
	return stagedPath, fields, nil
}

// pinnedAvatarCrop is the parsed `crop` query parameter. Every member must be a NUMBER for the crop to
// apply (characters.js:292), so presence is tracked with pointers rather than zero values.
type pinnedAvatarCrop struct {
	X          *float64 `json:"x"`
	Y          *float64 `json:"y"`
	Width      *float64 `json:"width"`
	Height     *float64 `json:"height"`
	WantResize bool     `json:"want_resize"`
}

func parseAvatarCrop(raw string) (pinnedAvatarCrop, bool) {
	if strings.TrimSpace(raw) == "" {
		return pinnedAvatarCrop{}, false
	}
	var crop pinnedAvatarCrop
	if err := json.Unmarshal([]byte(raw), &crop); err != nil {
		// tryParse returns undefined on a parse failure, which means "no crop" (util.js:571-577).
		return pinnedAvatarCrop{}, false
	}
	if crop.X == nil || crop.Y == nil || crop.Width == nil || crop.Height == nil {
		return pinnedAvatarCrop{}, false
	}
	return crop, true
}

// pinnedAvatarCropResize is applyAvatarCropResize (characters.js:283-306) in pure Go: crop, choose the
// final size, cover, encode PNG.
func pinnedAvatarCropResize(raw []byte, crop pinnedAvatarCrop, hasCrop bool) ([]byte, error) {
	source, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	finalWidth, finalHeight := source.Bounds().Dx(), source.Bounds().Dy()
	current := source
	if hasCrop {
		cropped := cropImage(source, int(*crop.X), int(*crop.Y), int(*crop.Width), int(*crop.Height))
		if cropped == nil {
			return nil, errors.New("crop rectangle is empty")
		}
		current = cropped
		if crop.WantResize {
			finalWidth, finalHeight = pinnedAvatarWidth, pinnedAvatarHeight
		} else {
			finalWidth, finalHeight = int(*crop.Width), int(*crop.Height)
		}
	}
	if finalWidth <= 0 || finalHeight <= 0 {
		return nil, errors.New("target size is empty")
	}
	covered := coverImage(current, finalWidth, finalHeight)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, covered); err != nil {
		return nil, err
	}
	return encoded.Bytes(), nil
}

// cropImage copies the requested rectangle, clamped to the source bounds. Jimp throws on a rectangle
// outside the image; clamping keeps the route answering with a valid image instead of a 400, which is the
// one place this deliberately differs and it is recorded in the compat row.
func cropImage(source image.Image, x, y, width, height int) image.Image {
	bounds := source.Bounds()
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	if width <= 0 || height <= 0 {
		return nil
	}
	if x+width > bounds.Max.X {
		width = bounds.Max.X - x
	}
	if y+height > bounds.Max.Y {
		height = bounds.Max.Y - y
	}
	if width <= 0 || height <= 0 {
		return nil
	}
	target := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(target, target.Bounds(), source, image.Pt(bounds.Min.X+x, bounds.Min.Y+y), draw.Src)
	return target
}

// coverImage is Jimp's `cover({w,h})`: scale so the image fills the target, then centre-crop.
func coverImage(source image.Image, width, height int) image.Image {
	bounds := source.Bounds()
	sourceWidth, sourceHeight := bounds.Dx(), bounds.Dy()
	if sourceWidth == width && sourceHeight == height {
		return source
	}
	scale := math.Max(float64(width)/float64(sourceWidth), float64(height)/float64(sourceHeight))
	scaledWidth := int(math.Round(float64(sourceWidth) * scale))
	scaledHeight := int(math.Round(float64(sourceHeight) * scale))
	if scaledWidth < width {
		scaledWidth = width
	}
	if scaledHeight < height {
		scaledHeight = height
	}
	scaled := image.NewRGBA(image.Rect(0, 0, scaledWidth, scaledHeight))
	xdraw.CatmullRom.Scale(scaled, scaled.Bounds(), source, bounds, draw.Over, nil)
	offsetX := (scaledWidth - width) / 2
	offsetY := (scaledHeight - height) / 2
	target := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(target, target.Bounds(), scaled, image.Pt(offsetX, offsetY), draw.Src)
	return target
}

// filenameFieldHasForbiddenPathCharacters is the middleware branch for a multipart TEXT field. It mirrors
// validateFileName.js:28-35 exactly: `/` and NUL, plus `\` where the platform separator is a backslash.
// `..` is NOT forbidden here — it reaches the sanitizer instead.
func filenameFieldHasForbiddenPathCharacters(value string) bool {
	forbidden := "/\x00"
	if os.PathSeparator == '\\' {
		forbidden += "\\"
	}
	return strings.ContainsAny(value, forbidden)
}

// invalidatePersonaThumbnail deletes `<user>/thumbnails/persona/<name>` (avatars.js:52). Absence is not an
// error: invalidateThumbnail unlinks if present.
func invalidatePersonaThumbnail(dataRoot, handle, filename string) {
	if filename == "" {
		return
	}
	directories, err := startup.DirectoriesForUser(dataRoot, handle)
	if err != nil {
		return
	}
	_ = os.Remove(filepath.Join(directories["thumbnailsPersona"], filename))
}
