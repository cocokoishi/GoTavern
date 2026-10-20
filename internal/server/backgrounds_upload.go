package server

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const pinnedUploadFieldSizeLimit = 500 << 20

var errBackgroundUploadMissing = errors.New("background upload is missing")

func (runtime *accountRuntime) serveBackgroundsUpload(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}

	staged, originalFilename, err := parseBackgroundMultipartUpload(request, runtime.options.DataRoot)
	if err != nil {
		if errors.Is(err, errBackgroundUploadMissing) || errors.Is(err, http.ErrNotMultipart) {
			serveStatusText(w, http.StatusBadRequest)
		} else {
			serveStatusText(w, http.StatusInternalServerError)
		}
		return
	}
	filename := startup.SanitizeUserFilename(originalFilename)
	if err := startup.InstallUserBackgroundUpload(runtime.options.DataRoot, account.string("handle"), staged, filename); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	if directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle")); err == nil {
		relativePath := filepath.Join("backgrounds", filename)
		_, _ = generateImageMetadataBatch(
			runtime.options.DataRoot,
			account.string("handle"),
			directories["root"],
			[]string{relativePath},
			orderedNodeJSON{kind: 's', scalar: "bg"},
			runtime.options.ImageMetadataThumbnailDimensions,
		)
	}
	respondText(w, http.StatusOK, "text/html; charset=utf-8", filename)
}

func parseBackgroundMultipartUpload(request *http.Request, dataRoot string) (string, string, error) {
	reader, err := request.MultipartReader()
	if err != nil {
		return "", "", err
	}
	var stagedPath string
	cleanup := func() {
		if stagedPath != "" {
			_ = removeStagedBackgroundUpload(stagedPath)
		}
	}
	var originalFilename string
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			cleanup()
			return "", "", err
		}
		fieldName := part.FormName()
		fileName := part.FileName()
		if fileName != "" {
			if fieldName != "avatar" || stagedPath != "" {
				_ = part.Close()
				cleanup()
				return "", "", errors.New("unexpected multipart file field")
			}
			staged, createErr := startup.CreateUploadStagingFile(dataRoot)
			if createErr != nil {
				_ = part.Close()
				cleanup()
				return "", "", createErr
			}
			stagedPath = staged.Name()
			_, copyErr := io.Copy(staged, part)
			partCloseErr := part.Close()
			stagedCloseErr := staged.Close()
			if copyErr != nil || partCloseErr != nil || stagedCloseErr != nil {
				cleanup()
				if copyErr != nil {
					return "", "", copyErr
				}
				if partCloseErr != nil {
					return "", "", partCloseErr
				}
				return "", "", stagedCloseErr
			}
			originalFilename = decodeMulterOriginalFilename(fileName)
			continue
		}

		fieldBytes, copyErr := io.Copy(io.Discard, io.LimitReader(part, pinnedUploadFieldSizeLimit+1))
		partCloseErr := part.Close()
		if copyErr != nil || partCloseErr != nil || fieldBytes > pinnedUploadFieldSizeLimit {
			cleanup()
			if copyErr != nil {
				return "", "", copyErr
			}
			if partCloseErr != nil {
				return "", "", partCloseErr
			}
			return "", "", errors.New("multipart field exceeds the pinned size limit")
		}
	}
	if stagedPath == "" {
		return "", "", errBackgroundUploadMissing
	}
	return stagedPath, originalFilename, nil
}

func decodeMulterOriginalFilename(filename string) string {
	if utf8.ValidString(filename) {
		return filename
	}
	// Busboy initially treats UTF-8 header bytes as Latin-1. The pinned
	// multerMonkeyPatch then decodes those bytes back to UTF-8.
	return strings.ToValidUTF8(filename, "\uFFFD")
}

func removeStagedBackgroundUpload(filename string) error {
	return os.Remove(filename)
}
