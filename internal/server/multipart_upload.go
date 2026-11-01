package server

// Bounded spooling for multipart FILE parts the product must hold in memory.
//
// THE PROBLEM this file exists for. Pinned's global multer is `multer({dest: uploadsPath, limits:
// {fieldSize: 500MB}})`: a FILE part is streamed to disk with NO size limit, and the route then streams
// from that file (src/endpoints/openai.js:805-806 `fs.createReadStream(request.file.path)`), so pinned's
// RSS does not grow with the audio size. GoTavern's outbound.Request carries a []byte, so the routes that
// forward an uploaded file must buffer it -- and their parse step used `io.ReadAll(part)`, which was
// UNBOUNDED: one authenticated upload of any size could take the process down. The same class existed in
// the sprite parser's 500MB in-memory read.
//
// THE POLICY, stated with its user-visible effect (docs/data-safety.md 8.4):
//   - the part is STREAMED to <dataRoot>/_uploads first, so a malformed/aborted request never grows
//     memory while streaming and a disk-full write fails causally;
//   - a buffered part is capped at maxBufferedMultipartUploadBytes; larger input is rejected with the
//     route's existing error status where pinned would have streamed it. The cap is generous for the
//     provider contract (the OpenAI-compatible audio APIs reject bodies far smaller than it), and it is a
//     RECORDED SECURITY BOUNDARY rather than a silent behaviour change;
//   - the staged file is always removed, on success and on every error path.

import (
	"errors"
	"io"
	"mime/multipart"
	"os"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// maxBufferedMultipartUploadBytes is the memory ceiling for one multipart FILE part that must be buffered.
// A var (not a const) so the upload-path tests can exercise the limit with a few bytes instead of 100 MB.
var maxBufferedMultipartUploadBytes int64 = 100 << 20

var errMultipartUploadTooLarge = errors.New("multipart file part exceeds the buffered upload limit")

// readBufferedMultipartPart stages one multipart FILE part on disk under a hard limit, reads it back, and
// removes the staging file. The peak memory is the limit, not the request size.
func readBufferedMultipartPart(dataRoot string, part *multipart.Part) ([]byte, error) {
	staged, err := startup.CreateUploadStagingFile(dataRoot)
	if err != nil {
		return nil, err
	}
	path := staged.Name()
	defer os.Remove(path)
	written, copyErr := io.Copy(staged, io.LimitReader(part, maxBufferedMultipartUploadBytes+1))
	closeErr := staged.Close()
	if copyErr != nil {
		return nil, copyErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if written > maxBufferedMultipartUploadBytes {
		return nil, errMultipartUploadTooLarge
	}
	return os.ReadFile(path)
}
