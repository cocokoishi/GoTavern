// Command user-store-recovery-fixture updates a Node-created user record using
// the same locked, atomic node-persist write path as account recovery.
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"

	"github.com/cocokoishi/gotavern/internal/startup"
	"golang.org/x/crypto/scrypt"
	"golang.org/x/text/unicode/norm"
)

const (
	storageKey = "user:recovery-roundtrip"
	password   = "pa\u0301ssword"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: user-store-recovery-fixture <data-root>")
		os.Exit(2)
	}
	salt := base64.StdEncoding.EncodeToString([]byte("roundtrip-salt-1"))
	derived, err := scrypt.Key([]byte(norm.NFC.String(password)), []byte(salt), 1<<14, 8, 1, 64)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	passwordHash := base64.StdEncoding.EncodeToString(derived)
	passwordJSON, _ := json.Marshal(passwordHash)
	saltJSON, _ := json.Marshal(salt)
	if err := startup.UpdateNodePersistRecord(os.Args[1], storageKey, func(value json.RawMessage) (json.RawMessage, error) {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(value, &fields); err != nil || fields == nil {
			return nil, fmt.Errorf("node-persist user value must be a JSON object")
		}
		fields["password"] = passwordJSON
		fields["salt"] = saltJSON
		return json.Marshal(fields)
	}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Password string `json:"password"`
		Salt     string `json:"salt"`
	}{Password: passwordHash, Salt: salt}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
