package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/cocokoishi/gotavern/internal/server"
	"github.com/cocokoishi/gotavern/internal/startup"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: image-metadata-roundtrip <data-root> <port> <thumbnail-dimensions-json>")
		os.Exit(2)
	}
	var thumbnailDimensions map[string]any
	if err := json.Unmarshal([]byte(os.Args[3]), &thumbnailDimensions); err != nil {
		fatal(err)
	}
	dataRoot, err := filepath.Abs(os.Args[1])
	if err != nil {
		fatal(err)
	}
	if _, err := startup.EnsureDirectories(dataRoot, dataRoot, []string{"default-user"}); err != nil {
		fatal(err)
	}
	handler := server.NewHTTPHandlerWithOptions(server.HTTPHandlerOptions{
		InstallRoot:                      dataRoot,
		DataRoot:                         dataRoot,
		AccountsEnabled:                  true,
		ImageMetadataThumbnailDimensions: thumbnailDimensions,
	})
	mux := http.NewServeMux()
	mux.Handle("/", handler)
	var running *http.Server
	mux.HandleFunc("POST /_gotavern-probe/shutdown", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = running.Shutdown(ctx)
		}()
	})
	running = &http.Server{Addr: "127.0.0.1:" + os.Args[2], Handler: mux}
	if err := running.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
