// Command user-store-avatar-fixture creates a node-persist avatar record with
// the same shared lock and atomic replacement used by account mutations.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: user-store-avatar-fixture <data-root>")
		os.Exit(2)
	}
	const key = "avatar:mutation-roundtrip"
	const avatar = "data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"/>"
	var encodedBuffer bytes.Buffer
	encoder := json.NewEncoder(&encodedBuffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(avatar); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := startup.SetNodePersistRecord(os.Args[1], key, bytes.TrimSpace(encodedBuffer.Bytes())); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Key    string `json:"key"`
		Avatar string `json:"avatar"`
	}{Key: key, Avatar: avatar}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
