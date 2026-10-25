package server

// POST /api/avatars/upload — the route that makes a persona avatar CREATABLE.
//
// Pinned src/endpoints/avatars.js:41-65 is the contract. This handler is deliberately THIN: the image work
// is `reencodeImage` in characters_write.go, which already implements the same pinned
// `applyAvatarCropResize` for /api/characters/edit-avatar. There is exactly ONE implementation of that rule
// in this package, because two implementations of one pinned rule are two oracles and the next divergence
// would be between them instead of against src/endpoints/characters.js.
//
// Two properties of the pinned request shape decide the order below:
//
//  1. multer is mounted APP-GLOBALLY (src/server-main.js:269: multer({dest: uploadsPath, limits:
//     {fieldSize: 500*1024*1024}}).single('avatar')), so the temp file exists before the route's own
//     middleware runs, and the multipart field is literally `avatar`. There is NO fileSize cap: pinned
//     accepts an arbitrarily large upload. We stream the part to disk rather than buffering it, and we do
//     not add a cap that would silently change behaviour.
//  2. getFileNameValidationFunction('overwrite_name') (src/middleware/validateFileName.js:19-41) runs
//     BEFORE the handler and refuses `/`, NUL and (on Windows) backslash with a bare 400. It does NOT
//     refuse `..` — that reaches the sanitizer. The two branches stay distinct, and each comment below
//     says which one a given name hits.

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// errAvatarUploadMissing is "there was no multipart file", which pinned answers with 400 rather than
// treating as a server fault (avatars.js:42).
var errAvatarUploadMissing = errors.New("avatar upload is missing")

func (runtime *accountRuntime) serveAvatarsUpload(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}

	// The staging file is removed on SUCCESS only (avatars.js:59). On a refusal pinned leaves multer's temp
	// file behind and so do we; that inherited leave-behind is recorded in the compat row rather than
	// papered over with a cleanup pinned does not perform.
	stagedPath, fields, parseErr := parseAvatarMultipartUpload(request, runtime.options.DataRoot)
	if parseErr != nil {
		if stagedPath != "" {
			_ = os.Remove(stagedPath)
		}
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	// validateFileName.js:28-35 — the FORBIDDEN-CHARACTER branch, before anything is written. A name like
	// ../x.png contains a slash and is refused here; `..` alone is NOT refused and falls through to the
	// sanitizer below, which is why these two checks are separate.
	overwriteName := fields["overwrite_name"]
	if filenameFieldHasForbiddenPathCharacters(overwriteName) {
		_ = os.Remove(stagedPath)
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	raw, readErr := os.ReadFile(stagedPath)
	if readErr != nil {
		_ = os.Remove(stagedPath)
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	// applyAvatarCropResize, via the ONE existing implementation: crop only when x/y/width/height are all
	// numbers; want_resize -> 512x768, otherwise exactly the crop dimensions; then cover.
	encoded, imageOK := reencodeImage(raw, parseAvatarCrop(request.URL.Query().Get("crop")))
	if !imageOK {
		// avatars.js:61-63 — the catch branch and its pinned literal body.
		_ = os.Remove(stagedPath)
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Is not a valid image")
		return
	}

	// avatars.js:56 — sanitize(overwrite_name || Date.now()+".png"). The `..`-style names that survived the
	// forbidden-character check are collapsed HERE.
	filename := startup.SanitizeUserFilename(overwriteName)
	if filename == "" {
		filename = strconv.FormatInt(time.Now().UnixMilli(), 10) + ".png"
	}

	// avatars.js:51-54 — invalidate the persona thumbnail BEFORE the write. This is the disk-observable
	// half. cacheBuster.bust (src/middleware/cacheBuster.js:101-105) only emits Clear-Site-Data when
	// cacheBuster.enabled is true, and that config defaults to FALSE (:28), so the shipped default
	// correctly emits no such header and this route does not add one.
	if overwriteName != "" {
		invalidatePersonaThumbnail(runtime.options.DataRoot, account.string("handle"), filename)
	}

	directories, dirErr := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if dirErr != nil {
		_ = os.Remove(stagedPath)
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	target := filepath.Join(directories["avatars"], filename)
	if writeErr := startup.WriteFileAtomic(target, encoded); writeErr != nil {
		_ = os.Remove(stagedPath)
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	_ = os.Remove(stagedPath)
	respondJSON(w, http.StatusOK, map[string]string{"path": filename})
}

// parseAvatarMultipartUpload streams the multipart body to a staging file in the same shape the backgrounds
// route uses: the file part must be named `avatar` (the pinned global multer field) and the text fields are
// returned to the handler. The body is never buffered in memory, because pinned imposes no file size limit
// and a cap here would be a silent behaviour change.
func parseAvatarMultipartUpload(request *http.Request, dataRoot string) (string, map[string]string, error) {
	reader, err := request.MultipartReader()
	if err != nil {
		return "", nil, err
	}
	stagedPath := ""
	fields := make(map[string]string)
	discard := func() {
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
			discard()
			return "", nil, err
		}
		if fileName := part.FileName(); fileName != "" {
			if part.FormName() != "avatar" || stagedPath != "" {
				_ = part.Close()
				discard()
				return "", nil, errors.New("unexpected multipart file field")
			}
			staged, createErr := startup.CreateUploadStagingFile(dataRoot)
			if createErr != nil {
				_ = part.Close()
				discard()
				return "", nil, createErr
			}
			stagedPath = staged.Name()
			_, copyErr := io.Copy(staged, part)
			partCloseErr := part.Close()
			stagedCloseErr := staged.Close()
			if copyErr != nil || partCloseErr != nil || stagedCloseErr != nil {
				discard()
				return "", nil, errors.New("copy multipart file")
			}
			continue
		}
		name := part.FormName()
		if name == "" {
			_ = part.Close()
			continue
		}
		value, readErr := io.ReadAll(io.LimitReader(part, int64(pinnedUploadFieldSizeLimit)+1))
		partCloseErr := part.Close()
		if readErr != nil || partCloseErr != nil || int64(len(value)) > int64(pinnedUploadFieldSizeLimit) {
			discard()
			return "", nil, errors.New("read multipart field")
		}
		fields[name] = string(value)
	}
	if stagedPath == "" {
		return "", nil, errAvatarUploadMissing
	}
	return stagedPath, fields, nil
}

// filenameFieldHasForbiddenPathCharacters is the middleware branch for a multipart TEXT field, mirroring
// validateFileName.js:28-35 exactly: slash and NUL, plus backslash where the platform separator is a
// backslash. `..` is NOT forbidden here.
func filenameFieldHasForbiddenPathCharacters(value string) bool {
	forbidden := "/\x00"
	if os.PathSeparator == '\\' {
		forbidden += "\\"
	}
	return strings.ContainsAny(value, forbidden)
}

// invalidatePersonaThumbnail deletes <user>/thumbnails/persona/<name> (avatars.js:52). Absence is not an
// error: pinned's invalidateThumbnail unlinks only if present.
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
