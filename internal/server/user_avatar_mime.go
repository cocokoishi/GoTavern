package server

// The pinned persona-avatar data URL, from src/users.js:704-733:
//
//	const mimeType = mime.lookup(avatarPath);            // :726
//	const base64Content = fs.readFileSync(avatarPath, 'base64');
//	return `data:${mimeType};base64,${base64Content}`;  // :728
//
// `mime` there is mime-types (src/users.js:12 imports 'mime-types'), NOT the
// mime@1.6.0 package that send@0.19.0 uses on every static path. The two pinned
// tables genuinely disagree, so using the static table here would be a silent
// value divergence rather than a host-dependent one:
//
//	.avif   mime-types -> image/avif          mime@1.6.0 -> application/octet-stream
//	.heic   mime-types -> image/heic          mime@1.6.0 -> application/octet-stream
//	.json   mime-types -> application/json    mime@1.6.0 -> application/json; charset=UTF-8
//	unknown mime-types -> false               mime@1.6.0 -> application/octet-stream
//
// mime-types also appends no charset, because the pinned line uses lookup()
// rather than contentType().
//
// Known gap, recorded in docs/compat-matrix.md: this path has no Node oracle
// until tools/probe-user-avatar-data-url.mjs was added, and it is the reason the
// wrong table reached main in be12d79 unnoticed.

import (
	"path"
	"strings"
)

// pinnedUserAvatarMediaType mirrors `mime.lookup` from src/users.js:726: it is
// extension-based, appends no charset, and reports a missing type separately so
// the caller can reproduce the template literal's interpolation.
func pinnedUserAvatarMediaType(name string) (string, bool) {
	extension := strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
	mediaType, exists := pinnedMimeTypesV3Types[extension]
	return mediaType, exists
}
