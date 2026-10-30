package startup

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/cocokoishi/gotavern/internal/fsretry"
	"github.com/cocokoishi/gotavern/internal/lockacquire"
	"github.com/cocokoishi/gotavern/upstream"
	"github.com/gofrs/flock"
)

const contentLockFolderName = "gotavern-content-seed-locks"

var userContentTargetKeys = map[string]string{
	"settings":       "root",
	"character":      "characters",
	"sprites":        "characters",
	"background":     "backgrounds",
	"world":          "worlds",
	"avatar":         "avatars",
	"theme":          "themes",
	"workflow":       "comfyWorkflows",
	"kobold_preset":  "koboldAI_Settings",
	"openai_preset":  "openAI_Settings",
	"novel_preset":   "novelAI_Settings",
	"textgen_preset": "textGen_Settings",
	"instruct":       "instruct",
	"context":        "context",
	"moving_ui":      "movingUI",
	"quick_replies":  "quickreplies",
	"sysprompt":      "sysprompt",
	"reasoning":      "reasoning",
}

type contentItem struct {
	Filename string `json:"filename"`
	Type     string `json:"type"`
	Folder   string `json:"-"`
}

// SeedOptions carries the configuration and forced categories accepted by the
// pinned checkForNewContent() startup helper.
type SeedOptions struct {
	SkipContentCheck bool
	ForceCategories  []string
}

// SeedResult reports which upstream content files were newly copied.
type SeedResult struct {
	GlobalContentAdded bool
	UserContentAdded   []bool
	AnyContentAdded    bool
}

// SeedDefaultContent copies pinned default/scaffold and default/content assets
// into global and per-user SillyTavern paths, updating the upstream
// content.log files. Existing targets are retained, and all writes are atomic.
func SeedDefaultContent(dataRoot string, directoriesList []UserDirectories, options SeedOptions) (SeedResult, error) {
	if options.SkipContentCheck && len(options.ForceCategories) == 0 {
		return SeedResult{}, nil
	}
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return SeedResult{}, fmt.Errorf("resolve data root: %w", err)
	}
	lockRoot, err := canonicalPath(absoluteRoot)
	if err != nil {
		return SeedResult{}, fmt.Errorf("resolve content-seeding root: %w", err)
	}
	lock, err := acquireContentLock(lockRoot)
	if err != nil {
		return SeedResult{}, err
	}
	defer lock.Close()

	items, err := loadPinnedContentIndex()
	if err != nil {
		return SeedResult{}, err
	}
	globalItems := make([]contentItem, 0, len(items))
	userItems := make([]contentItem, 0, len(items))
	for _, item := range items {
		if item.Type == "error_page" || item.Type == "stylesheet" {
			globalItems = append(globalItems, item)
		} else {
			userItems = append(userItems, item)
		}
	}

	result := SeedResult{UserContentAdded: make([]bool, len(directoriesList))}
	globalAdded, err := seedContent(globalItems, filepath.Join(absoluteRoot, "content.log"), absoluteRoot, nil, options.ForceCategories)
	if err != nil {
		return result, err
	}
	result.GlobalContentAdded = globalAdded
	result.AnyContentAdded = globalAdded
	for index, directories := range directoriesList {
		if directories["root"] == "" {
			return result, fmt.Errorf("user directory set %d has no root path", index)
		}
		if err := ensureDirectoryIfMissing(directories["root"]); err != nil {
			return result, fmt.Errorf("create user root %s: %w", directories["root"], err)
		}
		added, err := seedContent(userItems, filepath.Join(directories["root"], "content.log"), absoluteRoot, directories, options.ForceCategories)
		if err != nil {
			return result, err
		}
		result.UserContentAdded[index] = added
		result.AnyContentAdded = result.AnyContentAdded || added
	}
	return result, nil
}

func loadPinnedContentIndex() ([]contentItem, error) {
	items := make([]contentItem, 0)
	for _, source := range []struct {
		folder string
		index  string
	}{
		{folder: "default/scaffold", index: "default/scaffold/index.json"},
		{folder: "default/content", index: "default/content/index.json"},
	} {
		body, err := upstream.Assets.ReadFile(source.index)
		if errors.Is(err, fs.ErrNotExist) && source.folder == "default/scaffold" {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read pinned content index %s: %w", source.index, err)
		}
		var sourceItems []contentItem
		if err := json.Unmarshal(body, &sourceItems); err != nil {
			return nil, fmt.Errorf("decode pinned content index %s: %w", source.index, err)
		}
		for _, item := range sourceItems {
			item.Folder = source.folder
			items = append(items, item)
		}
	}
	return items, nil
}

func seedContent(items []contentItem, contentLogPath, dataRoot string, directories UserDirectories, forceCategories []string) (bool, error) {
	contentLog, err := readContentLog(contentLogPath)
	if err != nil {
		return false, fmt.Errorf("read content log %s: %w", contentLogPath, err)
	}
	forced := make(map[string]struct{}, len(forceCategories))
	for _, category := range forceCategories {
		forced[category] = struct{}{}
	}
	anyContentAdded := false
	for _, item := range items {
		if contains(contentLog, item.Filename) {
			if _, force := forced[item.Type]; !force {
				continue
			}
		}
		if item.Folder == "" {
			continue
		}
		sourcePath := path.Join(item.Folder, item.Filename)
		info, err := fs.Stat(upstream.Assets, sourcePath)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return anyContentAdded, fmt.Errorf("inspect pinned content %s: %w", sourcePath, err)
		}
		contentTarget := contentTarget(item.Type, dataRoot, directories)
		if contentTarget == "" {
			continue
		}
		baseName := filepath.Base(filepath.FromSlash(item.Filename))
		targetPath := filepath.Join(contentTarget, baseName)
		contentLog = append(contentLog, item.Filename)
		if _, err := os.Stat(targetPath); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return anyContentAdded, fmt.Errorf("inspect content target %s: %w", targetPath, err)
		}

		if err := os.MkdirAll(contentTarget, 0o777); err != nil {
			return anyContentAdded, fmt.Errorf("create content target %s: %w", contentTarget, err)
		}
		if info.IsDir() {
			if err := copyDirectoryAtomically(sourcePath, targetPath); err != nil {
				return anyContentAdded, fmt.Errorf("copy pinned content directory %s: %w", sourcePath, err)
			}
		} else {
			body, err := upstream.Assets.ReadFile(sourcePath)
			if err != nil {
				return anyContentAdded, fmt.Errorf("read pinned content %s: %w", sourcePath, err)
			}
			if err := atomicCreate(targetPath, body); err != nil {
				return anyContentAdded, fmt.Errorf("write seeded content %s: %w", targetPath, err)
			}
			if err := addOwnerWrite(targetPath); err != nil {
				return anyContentAdded, fmt.Errorf("set seeded content permissions %s: %w", targetPath, err)
			}
		}
		anyContentAdded = true
	}
	if err := atomicReplace(contentLogPath, []byte(strings.Join(contentLog, "\n"))); err != nil {
		return anyContentAdded, fmt.Errorf("write content log %s: %w", contentLogPath, err)
	}
	return anyContentAdded, nil
}

func contentTarget(contentType, dataRoot string, directories UserDirectories) string {
	if contentType == "error_page" {
		return filepath.Join(dataRoot, "_errors")
	}
	if contentType == "stylesheet" {
		return filepath.Join(dataRoot, "_css")
	}
	key, exists := userContentTargetKeys[contentType]
	if !exists {
		return ""
	}
	return directories[key]
}

func readContentLog(file string) ([]string, error) {
	body, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	return strings.Split(string(body), "\n"), nil
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func copyDirectoryAtomically(source, target string) error {
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o777); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, ".gotavern-seed-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := os.Chmod(stage, 0o755); err != nil {
		return err
	}
	if err := fs.WalkDir(upstream.Assets, source, func(assetPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if assetPath == source {
			return nil
		}
		relative := strings.TrimPrefix(assetPath, source+"/")
		destination := filepath.Join(stage, filepath.FromSlash(relative))
		if entry.IsDir() {
			if err := os.MkdirAll(destination, 0o755); err != nil {
				return err
			}
			return os.Chmod(destination, 0o755)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("unsupported pinned content type at %s", assetPath)
		}
		body, err := upstream.Assets.ReadFile(assetPath)
		if err != nil {
			return err
		}
		if err := atomicCreate(destination, body); err != nil {
			return err
		}
		return addOwnerWrite(destination)
	}); err != nil {
		return err
	}
	if _, err := os.Lstat(target); err == nil {
		return fmt.Errorf("target already exists: %s", target)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Rename(stage, target)
}

func addOwnerWrite(target string) error {
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	mode := info.Mode().Perm() | 0o200
	if mode == info.Mode().Perm() {
		return nil
	}
	return os.Chmod(target, mode)
}

// renameIntoPlace moves a finished temporary file over its target, and on Windows it RETRIES the sharing
// violation a concurrent READER causes.
//
// WHY THIS EXISTS. `os.Rename` over an existing file is atomic on both platforms, but Windows refuses it
// with `Access is denied` while any other handle has the destination open, and Go's `os.ReadFile` opens
// with FILE_SHARE_READ|FILE_SHARE_WRITE but NOT FILE_SHARE_DELETE. So a reader on the request path could
// make a concurrent write fail outright -- measured on this host (windows/arm64, 2026-10-29) by holding
// the target open and calling os.Rename: the write lost the race every time. The retry is bounded and
// Windows-only: Unix renames do not fail this way, so its behaviour is unchanged, and a genuinely stuck
// handle still returns an error after ~200 ms rather than hanging.
func renameIntoPlace(temporary, target string) error {
	return fsretry.Do(func() error { return os.Rename(temporary, target) })
}

func atomicReplace(target string, body []byte) error {
	directory := filepath.Dir(target)
	mode := fs.FileMode(0o666)
	if info, err := os.Stat(target); err == nil {
		mode = info.Mode().Perm()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	var temporary *os.File
	for attempt := 0; attempt < 8; attempt++ {
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			return err
		}
		name := ".gotavern-content-log-" + hex.EncodeToString(token) + ".tmp"
		file, err := os.OpenFile(filepath.Join(directory, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return err
		}
		temporary = file
		break
	}
	if temporary == nil {
		return errors.New("could not allocate a unique content-log temporary file")
	}
	tempName := temporary.Name()
	defer os.Remove(tempName)
	if mode != 0o666 {
		if err := temporary.Chmod(mode); err != nil {
			_ = temporary.Close()
			return err
		}
	}
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := renameIntoPlace(tempName, target); err != nil {
		return err
	}
	if directoryFile, err := os.Open(directory); err == nil {
		_ = directoryFile.Sync()
		_ = directoryFile.Close()
	}
	return nil
}

func acquireContentLock(dataRoot string) (*flock.Flock, error) {
	lockRoot := filepath.Join(os.TempDir(), contentLockFolderName)
	if err := os.MkdirAll(lockRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create content-seeding lock directory: %w", err)
	}
	key := dataRoot
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	digest := sha256.Sum256([]byte(key))
	lockPath := filepath.Join(lockRoot, hex.EncodeToString(digest[:])+".lock")
	lock, acquireErr := lockacquire.Acquire(lockPath, "content seeding")
	if acquireErr != nil {
		return nil, fmt.Errorf("lock content seeding for %s: %w", dataRoot, acquireErr)
	}
	return lock, nil
}
