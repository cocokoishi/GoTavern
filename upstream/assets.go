// Package upstream exposes the byte-identical SillyTavern compatibility assets.
package upstream

import "embed"

// Assets contains the pinned frontend, fresh-install defaults, generated frontend
// library, and their verification manifests.
//
//go:embed all:public all:default all:generated manifests SILLYTAVERN_VERSION SILLYTAVERN_COMMIT
var Assets embed.FS

const (
	SillyTavernVersion = "1.19.0"
	SillyTavernCommit  = "06bde939fb1e9c4c8d8641d810f0a916b5bce127"
)
