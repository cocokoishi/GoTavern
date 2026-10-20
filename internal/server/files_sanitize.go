package server

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const pinnedBodyParserLimit = 500 << 20

var errFileSanitizeBodyUnavailable = errors.New("file sanitization request body is unavailable")
var errFileSanitizeCoercion = errors.New("file name cannot be converted to a string")

func (runtime *accountRuntime) serveFileSanitizeFilename(w http.ResponseWriter, request *http.Request) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	filename, err := readFileSanitizeFilename(request)
	if errors.Is(err, errFileSanitizeBodyUnavailable) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err != nil {
		var parseError fileSanitizeParseError
		if errors.As(err, &parseError) {
			serveStatusText(w, parseError.status)
		} else if errors.Is(err, errFileSanitizeCoercion) {
			serveStatusText(w, http.StatusInternalServerError)
		} else {
			serveStatusText(w, http.StatusBadRequest)
		}
		return
	}
	if filename == "" {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "No fileName specified")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"fileName": startup.SanitizeUserFilename(filename)})
}

type fileSanitizeParseError struct {
	status int
	err    error
}

func (err fileSanitizeParseError) Error() string { return err.err.Error() }
func (err fileSanitizeParseError) Unwrap() error { return err.err }

func readFileSanitizeFilename(request *http.Request) (string, error) {
	contentType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil {
		if request.ContentLength == 0 && len(request.TransferEncoding) == 0 {
			return "undefined", nil
		}
		return "", errFileSanitizeBodyUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, pinnedBodyParserLimit+1))
	if err != nil {
		return "", fileSanitizeParseError{status: http.StatusBadRequest, err: err}
	}
	if int64(len(body)) > pinnedBodyParserLimit {
		return "", fileSanitizeParseError{status: http.StatusRequestEntityTooLarge, err: errors.New("request body exceeds the pinned 500 MB limit")}
	}

	switch contentType {
	case "application/json":
		if len(strings.TrimSpace(string(body))) == 0 {
			return "undefined", nil
		}
		trimmed := strings.TrimSpace(string(body))
		if trimmed[0] != '{' && trimmed[0] != '[' {
			return "", fileSanitizeParseError{status: http.StatusBadRequest, err: errors.New("JSON body must be an object or array")}
		}
		value, err := decodeOrderedNodeJSON(body)
		if err != nil {
			return "", fileSanitizeParseError{status: http.StatusBadRequest, err: err}
		}
		if filename, exists := value.member("fileName"); exists {
			text, err := filename.javascriptString()
			if err != nil {
				return "", errors.Join(errFileSanitizeCoercion, err)
			}
			return text, nil
		}
		return "undefined", nil
	case "application/x-www-form-urlencoded":
		values, err := url.ParseQuery(string(body))
		if err != nil {
			return "", fileSanitizeParseError{status: http.StatusBadRequest, err: err}
		}
		filenames := values["fileName"]
		if len(filenames) == 0 {
			return "undefined", nil
		}
		array := orderedNodeJSON{kind: 'a', array: make([]orderedNodeJSON, len(filenames))}
		for index, filename := range filenames {
			array.array[index] = orderedNodeJSON{kind: 's', scalar: filename}
		}
		if len(filenames) == 1 {
			return filenames[0], nil
		}
		return array.javascriptString()
	default:
		return "", errFileSanitizeBodyUnavailable
	}
}
