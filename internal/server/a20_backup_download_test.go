package server

// alpha.20 source-audit: /api/backups/chat/download answers like a hand-written file reader instead of
// pinned's `res.download` -> `send()` contract.
//
// EVIDENCE IS ALREADY RECORDED: tests/oracle/sillytavern-1.19.0-backups.json, step `backups.download.ok`,
// records the pinned response for a 42-byte `chat_alpha.jsonl` seeded with mtime 1700000000 (whole
// second):
//
//	status 200, contentType application/octet-stream, contentLength 42,
//	etag W/"2a-18bcfe56800"                       <- send()'s STAT etag: hex size - hex mtime-MILLISECONDS
//	contentDisposition attachment; filename="chat_alpha.jsonl"
//
// The generic replay comparator asserts only that an ETag is PRESENT (compareUserDataResponse:
// "the replay sent no ETag although pinned Node did"), so the recorded VALUE was never compared: GoTavern
// sent `httpx.WeakETag(body)` -- a sha1-of-content ETag -- and no Last-Modified / Accept-Ranges /
// Cache-Control at all.
//
// Pinned source read (not remembered): src/endpoints/backups.js:54 is `res.download(filePath)`;
// express's res.download -> res.sendFile -> send@0.19.0 with options {acceptRanges:true, cacheControl:true,
// etag:true, lastModified:true, maxAge:0}. 0x18bcfe56800 = 1700000000000 ms, i.e. `send`'s
// `etag(stats)` = W/"<size hex>-<mtime ms hex>", and send sets Last-Modified, Cache-Control
// "public, max-age=0" and Accept-Ranges: bytes. The route is POST, and Express's `req.fresh` is false for
// non-GET/HEAD, so pinned does NOT answer 304 here; the shared send helper preserves that because
// httpx.IsFresh refuses POST.

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// a20BackupDownload seeds one pinned-shaped backup and performs POST /api/backups/chat/download.
func a20BackupDownload(t *testing.T, env *charactersOracleEnv, name, body string, mtime time.Time) *httptest.ResponseRecorder {
	t.Helper()
	backups := env.Directories["backups"]
	if err := os.MkdirAll(backups, 0o777); err != nil {
		t.Fatalf("create backups dir: %v", err)
	}
	target := filepath.Join(backups, name)
	if err := os.WriteFile(target, []byte(body), 0o644); err != nil {
		t.Fatalf("seed backup: %v", err)
	}
	if err := os.Chtimes(target, mtime, mtime); err != nil {
		t.Fatalf("set backup mtime: %v", err)
	}
	return env.serve(t, http.MethodPost, "/api/backups/chat/download", "application/json",
		fmt.Sprintf(`{"name":%q}`, name))
}

// TestA20BackupDownloadMatchesTheRecordedPinnedSendContract asserts the headers the recorded pinned fixture
// carries for the same file: the stat ETag value, Last-Modified, Accept-Ranges and Cache-Control.
func TestA20BackupDownloadMatchesTheRecordedPinnedSendContract(t *testing.T) {
	env := newCharactersOracleEnv(t, "a20-download-cookie")
	// Exactly the fixture's file: 42 bytes, mtime 1700000000 (whole second).
	const body = "{\"user_name\":\"u\"}\n{\"mes\":\"a\"}\n{\"mes\":\"b\"}\n"
	response := a20BackupDownload(t, env, "chat_alpha.jsonl", body, time.Unix(1700000000, 0))
	if response.Code != http.StatusOK {
		t.Fatalf("POST /api/backups/chat/download = %d body %q", response.Code, response.Body.String())
	}
	if got := response.Body.String(); got != body {
		t.Fatalf("downloaded body = %q, want %q", got, body)
	}
	if got, want := response.Header().Get("ETag"), `W/"2a-18bcfe56800"`; got != want {
		t.Fatalf("ETag = %q, want the pinned recorded value %q (send()'s stat etag: size hex - mtime ms hex); "+
			"a content-hash ETag cannot revalidate against pinned's ETag", got, want)
	}
	if got, want := response.Header().Get("Last-Modified"), "Tue, 14 Nov 2023 22:13:20 GMT"; got != want {
		t.Fatalf("Last-Modified = %q, want %q (send sets it from stat.mtime)", got, want)
	}
	if got, want := response.Header().Get("Accept-Ranges"), "bytes"; got != want {
		t.Fatalf("Accept-Ranges = %q, want %q (send defaults acceptRanges: true)", got, want)
	}
	if got, want := response.Header().Get("Cache-Control"), "public, max-age=0"; got != want {
		t.Fatalf("Cache-Control = %q, want %q (res.sendFile with maxAge 0)", got, want)
	}
	if !strings.Contains(response.Header().Get("Content-Disposition"), `filename="chat_alpha.jsonl"`) {
		t.Fatalf("Content-Disposition = %q, want the attachment filename", response.Header().Get("Content-Disposition"))
	}
}
