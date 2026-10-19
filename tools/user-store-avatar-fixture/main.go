// Command user-store-avatar-fixture exercises locked account-store set/remove
// operations used by avatar changes and account deletion.
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
	const deletedKey = "user:delete-roundtrip"
	if err := startup.RemoveNodePersistRecord(os.Args[1], deletedKey); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Key        string `json:"key"`
		Avatar     string `json:"avatar"`
		DeletedKey string `json:"deletedKey"`
	}{Key: key, Avatar: avatar, DeletedKey: deletedKey}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
