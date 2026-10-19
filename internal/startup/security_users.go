package startup

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

func readSecuritySettingsUsers(dataRoot string) ([]SecuritySettingsUser, error) {
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve data root: %w", err)
	}
	entries, err := readStoreEntries(filepath.Join(absoluteRoot, storageFolder))
	if err != nil {
		return nil, err
	}
	users := make([]SecuritySettingsUser, 0)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Key, userKeyPrefix) {
			continue
		}
		var user SecuritySettingsUser
		if err := json.Unmarshal(entry.Value, &user); err != nil {
			return nil, fmt.Errorf("decode stored user %q: %w", strings.TrimPrefix(entry.Key, userKeyPrefix), err)
		}
		users = append(users, user)
	}
	return users, nil
}
