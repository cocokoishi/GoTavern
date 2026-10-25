package server

// Pinned /thumbnail, from src/endpoints/thumbnails.js (312 lines) mounted as
//
//	app.use('/thumbnail', thumbnailRouter)          src/server-startup.js:155
//	publicRouter.get('/')  thumbnails.js:249        (GET only; the apiRouter is EMPTY)
//
// WHY THIS IS A P0 RATHER THAN A GAP. public/script.js's getThumbnailUrl builds
// `/thumbnail?type=<bg|avatar|persona>&file=<name>` (script.js:7548), and it is what renders the
// character list (buildAvatarList), EVERY chat message avatar in both directions (script.js:2619,
// :2628), group collages, the persona list and zoomed persona, and the background gallery tiles
// (backgrounds.js:860, :1434). There is no onerror fallback, so while this route answered 404 every
// one of those images was a broken image. Worse, the frontend PERSISTS `mes.force_avatar` as a
// literal /thumbnail URL inside the chat .jsonl (script.js:5894, :6773), so chats written under
// pinned Node carry the URL into a GoTavern session and the defect cannot be worked around client
// side. See AGENTS.md 44-46, ARCHITECTURE.md 35.2 and docs/gate-blindspots.md.
//
// THE CODEC DECISION IS ALREADY MADE (ARCHITECTURE.md 35.2): pinned's bytes are Jimp output and Go
// cannot reproduce them, so this serves a REAL thumbnail from a pure-Go codec and the gate asserts
// the OBSERVABLE - status, MIME, decodability, dimensions, cache behaviour - never byte equality.
//
// BRANCH ORDER IS THE CONTRACT, and it is pinned's order (thumbnails.js:249-308). Every branch here
// exists because pinned answers differently there:
//
//	1. file/type not single-valued strings         -> 400   (typeof value !== 'string')
//	2. type outside {bg,avatar,persona}            -> 400
//	3. sanitize(rawFile) !== rawFile               -> 403   (an IDENTITY check, not a traversal fix)
//	4. thumbnails.enabled === false                -> the ORIGINAL bytes (404 when absent)
//	5. animated=true and the extension is skipped  -> the ORIGINAL bytes
//	6. extension is .gif                           -> the ORIGINAL bytes, before any cache check
//	7. cache miss                                  -> generate; a failed generate serves the ORIGINAL
//	8. cache present                               -> the CACHED bytes, under the ORIGINAL file name
//	9. otherwise                                   -> 404 (the frontend shows a placeholder)
//	   any unexpected failure                      -> 500
//
// The served MIME therefore comes from the ORIGINAL filename's extension even when the encoded format
// is jpeg (thumbnails.format defaults to 'jpg'), because pinned serves `sendFile(file, {root:
// thumbnailFolder})` with the original name. That mismatch is reproduced deliberately; do not "fix" it.

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerThumbnailRoutes)
}

// thumbnailTypeDirs is getThumbnailFolder/getOriginalFolder (thumbnails.js:35-75) expressed as
// startup.DirectoriesForUser keys.
var thumbnailTypeDirs = map[string]struct{ original, cache string }{
	// MUTATION (lane/asset-browser, temporary; reverted in the next commit): the avatar type is removed, so
	// /thumbnail?type=avatar takes the pinned 400 path. The asset gate must go RED on
	// noImageRequestFailedOnEitherLeg and on every character-list avatar failing to decode; if it stays green
	// then it cannot see the defect it was built for (AGENTS.md 31/32, differential doctrine 4).
	"persona": {"avatars", "thumbnailsPersona"},
	"bg":      {"backgrounds", "thumbnailsBg"},
}

// thumbnailSkippedExtensions is SKIPPED_EXTENSIONS (thumbnails.js:17). ALLOWED_IMAGE_EXTENSIONS in the
// same file is exported and imported nowhere, so it is not a gate and is not reproduced as one.
var thumbnailSkippedExtensions = map[string]bool{
	".apng": true, ".mp4": true, ".webm": true, ".avi": true,
	".mkv": true, ".flv": true, ".gif": true,
}

// ThumbnailSettings is the parsed thumbnails.* configuration. Configured distinguishes "the mapping
// never ran" from "the operator disabled thumbnails", because the zero value of Enabled is false and
// pinned's default is true.
type ThumbnailSettings struct {
	Enabled    bool
	PNGFormat  bool
	Quality    int
	Configured bool
}

// resolved applies pinned's defaults (thumbnails.js:20-22) when nothing was mapped.
func (settings ThumbnailSettings) resolved() ThumbnailSettings {
	if !settings.Configured {
		return ThumbnailSettings{Enabled: true, Quality: 95, Configured: true}
	}
	if settings.Quality < 1 {
		settings.Quality = 1
	}
	if settings.Quality > 100 {
		settings.Quality = 100
	}
	return settings
}

// thumbnailSettingsFromStartup parses the three config values with pinned's exact predicates:
// `enabled` defaults to true; `format` is `String(v).toLowerCase().trim() === 'png'`; `quality` is
// `Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.quality', 95, 'number'))))`. An
// ambiguous value resolves to the pinned default rather than to a Go zero value, because a zero here
// would silently disable a user's thumbnails.
func thumbnailSettingsFromStartup(enabled, format, quality any) ThumbnailSettings {
	settings := ThumbnailSettings{Enabled: true, Quality: 95, Configured: true}
	if value, ok := optionBooleanValue(enabled); ok {
		settings.Enabled = value
	}
	if text, ok := enabled.(string); ok {
		settings.Enabled = strings.EqualFold(strings.TrimSpace(text), "true")
	}
	if text, ok := format.(string); ok {
		settings.PNGFormat = strings.ToLower(strings.TrimSpace(text)) == "png"
	}
	if value, ok := optionNumber(quality); ok {
		settings.Quality = int(math.Round(value))
	}
	if settings.Quality < 1 {
		settings.Quality = 1
	}
	if settings.Quality > 100 {
		settings.Quality = 100
	}
	return settings
}

func registerThumbnailRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	// GET-only, like the pinned router: every other method falls through the express router to the
	// rest of the app, which for this server is the frontend static handler (and its 404).
	//
	// BOTH spellings are registered because pinned mounts the router at '/thumbnail' and registers
	// publicRouter.get('/'), so /thumbnail and /thumbnail/ reach the same handler.
	for _, pattern := range []string{"/thumbnail", "/thumbnail/"} {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			accounts.serveThumbnail(w, r)
		})
	}
}

// serveThumbnail is thumbnails.js:249.
func (runtime *accountRuntime) serveThumbnail(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	// (1) pinned: `if (typeof rawFile !== 'string' || typeof type !== 'string') return 400`.
	// A repeated key arrives as an array in Express and is therefore not a string; net/url keeps the
	// values, so reading the length reproduces the same decision for the same reason.
	rawFile, fileIsSingle := thumbnailSingleValue(query, "file")
	typeValue, typeIsSingle := thumbnailSingleValue(query, "type")
	if !fileIsSingle || !typeIsSingle {
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	// (2) pinned: `if (!(type === 'bg' || type === 'avatar' || type === 'persona')) return 400`.
	keys, knownType := thumbnailTypeDirs[typeValue]
	if !knownType {
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	// (3) pinned: `const file = sanitize(rawFile); if (file !== rawFile) return 403`.
	//
	// This is an IDENTITY comparison, not a traversal guard: `../hero.png` is refused because the
	// sanitizer changes it, which is also why a CJK name, a space or an interior dot must survive it
	// unchanged. Do not harden this into a different predicate; a stricter check would answer 403
	// where pinned serves the file, and real users have `[REDACTED_CARD].png` in this exact directory.
	if startup.SanitizeUserFilename(rawFile) != rawFile {
		serveStatusText(w, http.StatusForbidden)
		return
	}

	_, directories, ok := runtime.sdUser(w, r)
	if !ok {
		return
	}
	settings := runtime.options.Thumbnails.resolved()

	originalPath := filepath.Join(directories[keys.original], rawFile)
	cachePath := filepath.Join(directories[keys.cache], rawFile)

	// serveOriginal is pinned's `serveOriginal()` closure (thumbnails.js:260-266): a missing original
	// is res.sendStatus(404) (text/plain), otherwise sendFile of the original.
	serveOriginal := func() {
		if serveThumbnailFile(w, r, originalPath) {
			return
		}
		serveStatusText(w, http.StatusNotFound)
	}

	// (4) thumbnails.enabled === false: no generation at all.
	if !settings.Enabled {
		serveOriginal()
		return
	}

	extension := strings.ToLower(filepath.Ext(rawFile))
	// (5) an explicitly animated request for a skipped format is served as-is.
	if query.Get("animated") == "true" && thumbnailSkippedExtensions[extension] {
		serveOriginal()
		return
	}
	// (6) a .gif is always served as-is, before the cache is even consulted.
	if extension == ".gif" {
		serveOriginal()
		return
	}

	// (7) a cache miss generates; a failed generation serves the original.
	if _, err := os.Stat(cachePath); err != nil {
		if !runtime.generateThumbnail(originalPath, cachePath, typeValue, extension, settings) {
			serveOriginal()
			return
		}
	}

	// (8) the cached file, under its ORIGINAL name, which is what decides the MIME.
	if !serveThumbnailFile(w, r, cachePath) {
		// (9) `Send a 404 so the frontend can display a placeholder`.
		serveStatusText(w, http.StatusNotFound)
	}
}

// thumbnailSingleValue reports whether a query key is present exactly once.
func thumbnailSingleValue(query map[string][]string, key string) (string, bool) {
	values, present := query[key]
	if !present || len(values) != 1 {
		return "", false
	}
	return values[0], true
}

// serveThumbnailFile transfers one file with the pinned send() semantics this repository already
// reproduces for every other static path, plus pinned's Firefox cache-defeat header.
func serveThumbnailFile(w http.ResponseWriter, r *http.Request, target string) bool {
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		return false
	}
	invalidateThumbnailFirefoxCache(r, w, target)
	sendPinnedExtensionBytes(w, r, target, info)
	return true
}

// invalidateThumbnailFirefoxCache is util.js's invalidateFirefoxCache: for a Firefox user agent and a
// path whose mime is an image, `Cache-Control: must-understand, no-store` REPLACES the `public,
// max-age=0` send() would set. Only the header effect is observable, and only that is reproduced.
func invalidateThumbnailFirefoxCache(r *http.Request, w http.ResponseWriter, target string) {
	if !strings.Contains(strings.ToLower(r.UserAgent()), "firefox") {
		return
	}
	if !strings.HasPrefix(staticContentType(filepath.Base(target)), "image/") {
		return
	}
	w.Header().Set("Cache-Control", "must-understand, no-store")
}

// generateThumbnail is generateThumbnail+processSingleImage (thumbnails.js:103-242). It returns false
// on every pinned "no thumbnail" path, and the caller then serves the original.
func (runtime *accountRuntime) generateThumbnail(originalPath, cachePath, typeValue, extension string, settings ThumbnailSettings) bool {
	data, err := os.ReadFile(originalPath)
	if err != nil {
		return false
	}

	// Animated sources are the client's problem in pinned, not ours: an animated webp or APNG
	// returns null so the original is served. Detection is a 200-BYTE SCAN in pinned
	// (image-metadata.js:65-77), not a decode, and it is reproduced as such.
	if extension == ".webp" && thumbnailHasMarker(data, "ANIM", "ANMF") {
		return false
	}
	if extension == ".png" && thumbnailHasMarker(data, "acTL") {
		return false
	}
	if thumbnailSkippedExtensions[extension] {
		return false
	}

	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return false
	}
	sourceBounds := source.Bounds()
	sourceWidth, sourceHeight := sourceBounds.Dx(), sourceBounds.Dy()
	if sourceWidth <= 0 || sourceHeight <= 0 {
		return false
	}

	width, height := thumbnailDimensionsFor(runtime.options.ImageMetadataThumbnailDimensions, typeValue)
	var destination *image.RGBA
	if typeValue == "bg" {
		// Pinned keeps the configured pixel AREA at the source's aspect ratio:
		//   w = round(sqrt(area * ratio)), h = round(sqrt(area / ratio))
		ratio := float64(sourceWidth) / float64(sourceHeight)
		area := float64(width * height)
		targetWidth := int(math.Round(math.Sqrt(area * ratio)))
		targetHeight := int(math.Round(math.Sqrt(area / ratio)))
		if targetWidth < 1 {
			targetWidth = 1
		}
		if targetHeight < 1 {
			targetHeight = 1
		}
		destination = image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
		draw.BiLinear.Scale(destination, destination.Bounds(), source, sourceBounds, draw.Over, nil)
	} else {
		// avatar/persona COVER to exactly the configured size: centre crop the source to the target
		// aspect ratio, then scale it to the target.
		destination = image.NewRGBA(image.Rect(0, 0, width, height))
		coverRect := thumbnailCoverRect(sourceBounds, width, height)
		draw.BiLinear.Scale(destination, destination.Bounds(), source, coverRect, draw.Over, nil)
	}

	var encoded bytes.Buffer
	if settings.PNGFormat {
		if err := png.Encode(&encoded, destination); err != nil {
			return false
		}
	} else if err := jpeg.Encode(&encoded, destination, &jpeg.Options{Quality: settings.Quality}); err != nil {
		return false
	}

	if err := os.MkdirAll(filepath.Dir(cachePath), 0o777); err != nil {
		return false
	}
	// writeFileAtomicSync in pinned: a pid-suffixed temporary file plus rename.
	if err := startup.WriteFileAtomic(cachePath, encoded.Bytes()); err != nil {
		return false
	}
	return true
}

// thumbnailCoverRect is Jimp's `cover`: the centred sub-rectangle of the source whose aspect ratio
// equals the target's, so scaling it to the target does not distort the picture.
func thumbnailCoverRect(bounds image.Rectangle, width, height int) image.Rectangle {
	sourceWidth, sourceHeight := bounds.Dx(), bounds.Dy()
	scale := math.Max(float64(width)/float64(sourceWidth), float64(height)/float64(sourceHeight))
	cropWidth := int(math.Round(float64(width) / scale))
	cropHeight := int(math.Round(float64(height) / scale))
	if cropWidth < 1 {
		cropWidth = 1
	}
	if cropHeight < 1 {
		cropHeight = 1
	}
	if cropWidth > sourceWidth {
		cropWidth = sourceWidth
	}
	if cropHeight > sourceHeight {
		cropHeight = sourceHeight
	}
	left := bounds.Min.X + (sourceWidth-cropWidth)/2
	top := bounds.Min.Y + (sourceHeight-cropHeight)/2
	return image.Rect(left, top, left+cropWidth, top+cropHeight)
}

// thumbnailHasMarker reports whether one of the marker strings appears in the first 200 bytes, which
// is exactly what isAnimatedApng/isAnimatedWebP look at (image-metadata.js:65-77).
func thumbnailHasMarker(data []byte, markers ...string) bool {
	window := data
	if len(window) > 200 {
		window = window[:200]
	}
	for _, marker := range markers {
		if bytes.Contains(window, []byte(marker)) {
			return true
		}
	}
	return false
}

// thumbnailDimensionsFor reads thumbnails.dimensions.<type> out of the handler options, falling back
// to pinned's defaults (160x90 for bg, 96x144 for avatar and persona) when the value is absent or
// malformed. The options map is built from config.yaml, so a nil here means "not configured".
func thumbnailDimensionsFor(dimensions map[string]any, typeValue string) (int, int) {
	defaultWidth, defaultHeight := 96, 144
	if typeValue == "bg" {
		defaultWidth, defaultHeight = 160, 90
	}
	value, present := dimensions[typeValue]
	if !present {
		return defaultWidth, defaultHeight
	}
	numbers, ok := value.([]any)
	if !ok || len(numbers) < 2 {
		return defaultWidth, defaultHeight
	}
	width, widthOK := optionNumber(numbers[0])
	height, heightOK := optionNumber(numbers[1])
	if !widthOK || !heightOK || width < 1 || height < 1 {
		return defaultWidth, defaultHeight
	}
	return int(math.Round(width)), int(math.Round(height))
}
