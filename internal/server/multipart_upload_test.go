package server

// Upload memory policy tests (multipart_upload.go and the sprite parser refactor).
//
// WHY THESE EXIST: both parse paths used `io.ReadAll(part)` -- an unbounded heap buffer an authenticated
// client could grow until the process died, where pinned's multer streams file parts to disk. The tests
// pin the three properties the fix relies on:
//   1. an ordinary file part is spooled and returned intact;
//   2. a part beyond the buffered limit is REJECTED (the recorded boundary) rather than buffered;
//   3. the staging file is removed on success, on oversize rejection and on a truncated/malformed body.
// Plus the sprite route itself: a streamed file lands byte-identically and leaves nothing in _uploads.

import (
	"archive/zip"
	"bytes"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func buildMultipartFileBody(t *testing.T, filename string, content []byte) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("avatar", filename)
	if err != nil {
		t.Fatalf("create the file part: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write the file part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close the multipart body: %v", err)
	}
	return body.Bytes(), writer.FormDataContentType()
}

func firstMultipartPart(t *testing.T, body []byte, contentType string) (*multipart.Part, func()) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	request.Header.Set("Content-Type", contentType)
	reader, err := request.MultipartReader()
	if err != nil {
		t.Fatalf("open the multipart reader: %v", err)
	}
	part, err := reader.NextPart()
	if err != nil {
		t.Fatalf("read the first part: %v", err)
	}
	return part, func() { _ = part.Close() }
}

func uploadStagingDirectory(t *testing.T, dataRoot string) string {
	t.Helper()
	directory := filepath.Join(dataRoot, "_uploads")
	if err := os.MkdirAll(directory, 0o777); err != nil {
		t.Fatalf("create the upload staging directory: %v", err)
	}
	return directory
}

func requireNoStagedUploads(t *testing.T, dataRoot string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dataRoot, "_uploads"))
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		t.Fatalf("read the upload staging directory: %v", err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("the request left %d staged upload(s) behind: %v", len(entries), names)
	}
}

func TestReadBufferedMultipartPartSpoolsAndReturnsTheBytes(t *testing.T) {
	dataRoot := t.TempDir()
	uploadStagingDirectory(t, dataRoot)
	content := bytes.Repeat([]byte("audio-frame-"), 1024)
	body, contentType := buildMultipartFileBody(t, "audio.wav", content)
	part, closePart := firstMultipartPart(t, body, contentType)
	defer closePart()
	got, err := readBufferedMultipartPart(dataRoot, part)
	if err != nil {
		t.Fatalf("readBufferedMultipartPart: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("the spooled part differs from the uploaded bytes (%d vs %d bytes)", len(got), len(content))
	}
	requireNoStagedUploads(t, dataRoot)
}

func TestReadBufferedMultipartPartRejectsAnOversizePartAndRemovesTheStagingFile(t *testing.T) {
	dataRoot := t.TempDir()
	uploadStagingDirectory(t, dataRoot)
	originalLimit := maxBufferedMultipartUploadBytes
	maxBufferedMultipartUploadBytes = 1024
	defer func() { maxBufferedMultipartUploadBytes = originalLimit }()

	body, contentType := buildMultipartFileBody(t, "audio.wav", bytes.Repeat([]byte("x"), 4096))
	part, closePart := firstMultipartPart(t, body, contentType)
	defer closePart()
	_, err := readBufferedMultipartPart(dataRoot, part)
	if !errors.Is(err, errMultipartUploadTooLarge) {
		t.Fatalf("a 4KB part against a 1KB limit returned %v, want errMultipartUploadTooLarge", err)
	}
	requireNoStagedUploads(t, dataRoot)
}

func TestReadBufferedMultipartPartRemovesTheStagingFileOnATruncatedBody(t *testing.T) {
	dataRoot := t.TempDir()
	uploadStagingDirectory(t, dataRoot)
	body, contentType := buildMultipartFileBody(t, "audio.wav", bytes.Repeat([]byte("y"), 4096))
	truncated := body[:len(body)-32]
	part, closePart := firstMultipartPart(t, truncated, contentType)
	defer closePart()
	if _, err := readBufferedMultipartPart(dataRoot, part); err == nil {
		t.Fatalf("a truncated multipart body was read without an error")
	}
	requireNoStagedUploads(t, dataRoot)
}

// buildSpritesUploadBody builds `multipart/form-data` with the `name` field and one `avatar` file part,
// the two parts the sprite route reads.
func buildSpritesUploadBody(t *testing.T, name, label, filename string, content []byte) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("name", name); err != nil {
		t.Fatalf("write the name field: %v", err)
	}
	if err := writer.WriteField("label", label); err != nil {
		t.Fatalf("write the label field: %v", err)
	}
	part, err := writer.CreateFormFile("avatar", filename)
	if err != nil {
		t.Fatalf("create the avatar part: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write the avatar part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close the sprites multipart body: %v", err)
	}
	return body.Bytes(), writer.FormDataContentType()
}

func spritesTestHandler(t *testing.T) (handler http.Handler, cookie, token, dataRoot, userRoot string) {
	t.Helper()
	dataRoot = t.TempDir()
	handler, cookie, token = newSDRouteHandler(t, dataRoot, t.TempDir(), "sprites-streaming-cookie-secret",
		sdFixtureAccount{Handle: "default-user", Name: "Sprite Streaming Probe", Admin: true})
	uploadStagingDirectory(t, dataRoot)
	userRoot = userRootPath(dataRoot)
	if err := os.MkdirAll(filepath.Join(userRoot, "characters", "SpriteChar"), 0o777); err != nil {
		t.Fatalf("seed the sprite character directory: %v", err)
	}
	return handler, cookie, token, dataRoot, userRoot
}

func serveSpritesRequest(t *testing.T, handler http.Handler, cookie, token, route string, body []byte, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, route, bytes.NewReader(body))
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Cookie", cookie)
	request.Header.Set("X-CSRF-Token", token)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestSpritesUploadStoresAStreamedFileAndLeavesNoStagedUpload(t *testing.T) {
	handler, cookie, token, dataRoot, userRoot := spritesTestHandler(t)
	content := bytes.Repeat([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a}, 128*1024)
	body, contentType := buildSpritesUploadBody(t, "SpriteChar", "joy", "joy.png", content)
	recorder := serveSpritesRequest(t, handler, cookie, token, "/api/sprites/upload", body, contentType)
	if recorder.Code != http.StatusOK {
		t.Fatalf("POST /api/sprites/upload = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	stored, err := os.ReadFile(filepath.Join(userRoot, "characters", "SpriteChar", "joy.png"))
	if err != nil {
		t.Fatalf("read the stored sprite: %v", err)
	}
	if !bytes.Equal(stored, content) {
		t.Fatalf("the stored sprite differs from the uploaded bytes (%d vs %d bytes)", len(stored), len(content))
	}
	requireNoStagedUploads(t, dataRoot)
}

func TestSpritesUploadZipRejectsAnEntryBeyondTheExtractionCapAndCleansStaging(t *testing.T) {
	handler, cookie, token, dataRoot, userRoot := spritesTestHandler(t)
	originalEntryLimit := maxSpriteArchiveEntryBytes
	maxSpriteArchiveEntryBytes = 1024
	defer func() { maxSpriteArchiveEntryBytes = originalEntryLimit }()

	var archive bytes.Buffer
	zipWriter := zip.NewWriter(&archive)
	entry, err := zipWriter.Create("joy.png")
	if err != nil {
		t.Fatalf("create the zip entry: %v", err)
	}
	if _, err := entry.Write(bytes.Repeat([]byte("z"), 4096)); err != nil {
		t.Fatalf("write the zip entry: %v", err)
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatalf("close the zip: %v", err)
	}
	body, contentType := buildSpritesUploadBody(t, "SpriteChar", "bundle", "sprites.zip", archive.Bytes())
	recorder := serveSpritesRequest(t, handler, cookie, token, "/api/sprites/upload-zip", body, contentType)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("an over-cap zip entry = %d, want the route's 500: %s", recorder.Code, recorder.Body.String())
	}
	if entries, err := os.ReadDir(filepath.Join(userRoot, "characters", "SpriteChar")); err != nil || len(entries) != 0 {
		t.Fatalf("a rejected zip wrote sprite files: entries=%d err=%v", len(entries), err)
	}
	requireNoStagedUploads(t, dataRoot)
}

func TestSpritesUploadRemovesStagingOnAMalformedMultipartBody(t *testing.T) {
	handler, cookie, token, dataRoot, _ := spritesTestHandler(t)
	body, contentType := buildSpritesUploadBody(t, "SpriteChar", "joy", "joy.png", bytes.Repeat([]byte("w"), 64*1024))
	truncated := body[:len(body)-64]
	recorder := serveSpritesRequest(t, handler, cookie, token, "/api/sprites/upload", truncated, contentType)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("a malformed multipart body = %d, want 500: %s", recorder.Code, recorder.Body.String())
	}
	requireNoStagedUploads(t, dataRoot)
}
