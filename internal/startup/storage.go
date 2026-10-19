// Package startup reproduces the pinned SillyTavern account-store and data
// directory initialization contracts.
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
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

const (
	userKeyPrefix  = "user:"
	defaultHandle  = "default-user"
	defaultName    = "User"
	storageFolder  = "_storage"
	lockFolderName = "gotavern-user-storage-locks"
)

type storeEntry struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value,omitempty"`
	TTL   json.RawMessage `json:"ttl,omitempty"`
}

type defaultUser struct {
	Handle   string `json:"handle"`
	Name     string `json:"name"`
	Created  int64  `json:"created"`
	Password string `json:"password"`
	Admin    bool   `json:"admin"`
	Enabled  bool   `json:"enabled"`
	Salt     string `json:"salt"`
}

// UserDirectories maps the pinned JavaScript directory property names to
// their paths for a single user.
type UserDirectories map[string]string

type directoryTemplate struct {
	key      string
	relative string
}

var userDirectoryTemplate = []directoryTemplate{
	{key: "root", relative: ""},
	{key: "thumbnails", relative: "thumbnails"},
	{key: "thumbnailsBg", relative: filepath.Join("thumbnails", "bg")},
	{key: "thumbnailsAvatar", relative: filepath.Join("thumbnails", "avatar")},
	{key: "thumbnailsPersona", relative: filepath.Join("thumbnails", "persona")},
	{key: "worlds", relative: "worlds"},
	{key: "user", relative: "user"},
	{key: "avatars", relative: "User Avatars"},
	{key: "userImages", relative: filepath.Join("user", "images")},
	{key: "groups", relative: "groups"},
	{key: "groupChats", relative: "group chats"},
	{key: "chats", relative: "chats"},
	{key: "characters", relative: "characters"},
	{key: "backgrounds", relative: "backgrounds"},
	{key: "novelAI_Settings", relative: "NovelAI Settings"},
	{key: "koboldAI_Settings", relative: "KoboldAI Settings"},
	{key: "openAI_Settings", relative: "OpenAI Settings"},
	{key: "textGen_Settings", relative: "TextGen Settings"},
	{key: "themes", relative: "themes"},
	{key: "movingUI", relative: "movingUI"},
	{key: "extensions", relative: "extensions"},
	{key: "instruct", relative: "instruct"},
	{key: "context", relative: "context"},
	{key: "quickreplies", relative: "QuickReplies"},
	{key: "assets", relative: "assets"},
	{key: "comfyWorkflows", relative: filepath.Join("user", "workflows")},
	{key: "files", relative: filepath.Join("user", "files")},
	{key: "vectors", relative: "vectors"},
	{key: "backups", relative: "backups"},
	{key: "sysprompt", relative: "sysprompt"},
	{key: "reasoning", relative: "reasoning"},
}

var publicDirectoryTemplate = []directoryTemplate{
	{key: "images", relative: filepath.Join("public", "img")},
	{key: "backups", relative: "backups"},
	{key: "sounds", relative: filepath.Join("public", "sounds")},
	{key: "extensions", relative: filepath.Join("public", "scripts", "extensions")},
	{key: "globalExtensions", relative: filepath.Join("public", "scripts", "extensions", "third-party")},
}

// InitializeUserStorage loads the pinned node-persist file format and creates
// SillyTavern's default account only when no user:* record exists. Existing
// records are read but never rewritten.
func InitializeUserStorage(dataRoot string) ([]string, error) {
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve data root: %w", err)
	}
	storageDir := filepath.Join(absoluteRoot, storageFolder)
	if err := os.MkdirAll(storageDir, 0o777); err != nil {
		return nil, fmt.Errorf("create user storage directory: %w", err)
	}
	canonicalDir, err := canonicalPath(storageDir)
	if err != nil {
		return nil, fmt.Errorf("resolve user storage directory: %w", err)
	}
	lock, err := acquireStorageLock(canonicalDir)
	if err != nil {
		return nil, err
	}
	defer lock.Close()

	entries, err := readStoreEntries(storageDir)
	if err != nil {
		return nil, err
	}
	handles := make([]string, 0)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Key, userKeyPrefix) {
			handles = append(handles, strings.TrimPrefix(entry.Key, userKeyPrefix))
		}
	}
	if len(handles) == 0 {
		key := userKeyPrefix + defaultHandle
		value, err := json.Marshal(defaultUser{
			Handle:   defaultHandle,
			Name:     defaultName,
			Created:  time.Now().UnixMilli(),
			Password: "",
			Admin:    true,
			Enabled:  true,
			Salt:     "",
		})
		if err != nil {
			return nil, fmt.Errorf("encode default user: %w", err)
		}
		body, err := json.Marshal(storeEntry{Key: key, Value: value})
		if err != nil {
			return nil, fmt.Errorf("encode default user storage entry: %w", err)
		}
		filename := storeFilename(key)
		target := filepath.Join(storageDir, filename)
		if _, err := os.Lstat(target); err == nil {
			return nil, fmt.Errorf("refusing to replace existing node-persist record %s", target)
		} else if !errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("inspect node-persist record %s: %w", target, err)
		}
		if err := atomicCreate(target, body); err != nil {
			return nil, fmt.Errorf("write default user storage record: %w", err)
		}
		handles = append(handles, defaultHandle)
	}
	return handles, nil
}

// UpdateNodePersistRecord updates one existing node-persist record under the
// same lock used by user-storage startup. The replacement is atomic so a
// process interruption cannot leave the record partially encoded.
func UpdateNodePersistRecord(dataRoot, key string, update func(json.RawMessage) (json.RawMessage, error)) error {
	if key == "" || update == nil {
		return errors.New("node-persist record update requires a key and callback")
	}
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return fmt.Errorf("resolve data root: %w", err)
	}
	storageDir := filepath.Join(absoluteRoot, storageFolder)
	canonicalDir, err := canonicalPath(storageDir)
	if err != nil {
		return fmt.Errorf("resolve user storage directory: %w", err)
	}
	lock, err := acquireStorageLock(canonicalDir)
	if err != nil {
		return err
	}
	defer lock.Close()

	target := filepath.Join(storageDir, storeFilename(key))
	body, err := os.ReadFile(target)
	if err != nil {
		return fmt.Errorf("read node-persist record %s: %w", key, err)
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(body, &record); err != nil || record == nil {
		return fmt.Errorf("decode node-persist record %s: invalid JSON object", key)
	}
	var storedKey string
	if json.Unmarshal(record["key"], &storedKey) != nil || storedKey != key {
		return fmt.Errorf("node-persist record filename does not contain key %s", key)
	}
	updatedValue, err := update(record["value"])
	if err != nil {
		return err
	}
	if !json.Valid(updatedValue) {
		return fmt.Errorf("node-persist record %s update returned invalid JSON", key)
	}
	record["value"] = updatedValue
	updatedRecord, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode node-persist record %s: %w", key, err)
	}
	if err := atomicReplace(target, updatedRecord); err != nil {
		return fmt.Errorf("write node-persist record %s: %w", key, err)
	}
	return nil
}

// SetNodePersistRecord writes one node-persist key using the same file shape
// and shared lock as startup and account updates. The upstream setItem
// operation replaces the record wrapper and resets its TTL to the store
// default, so this intentionally writes only key and value.
func SetNodePersistRecord(dataRoot, key string, value json.RawMessage) error {
	if key == "" || !json.Valid(value) {
		return errors.New("node-persist record set requires a key and valid JSON value")
	}
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return fmt.Errorf("resolve data root: %w", err)
	}
	storageDir := filepath.Join(absoluteRoot, storageFolder)
	if err := os.MkdirAll(storageDir, 0o777); err != nil {
		return fmt.Errorf("create user storage directory: %w", err)
	}
	canonicalDir, err := canonicalPath(storageDir)
	if err != nil {
		return fmt.Errorf("resolve user storage directory: %w", err)
	}
	lock, err := acquireStorageLock(canonicalDir)
	if err != nil {
		return err
	}
	defer lock.Close()

	encodedKey, err := marshalNodeJSONString(key)
	if err != nil {
		return err
	}
	body := make([]byte, 0, len(encodedKey)+len(value)+18)
	body = append(body, `{"key":`...)
	body = append(body, encodedKey...)
	body = append(body, `,"value":`...)
	body = append(body, value...)
	body = append(body, '}')
	target := filepath.Join(storageDir, storeFilename(key))
	if _, err := os.Lstat(target); err == nil {
		if err := atomicReplace(target, body); err != nil {
			return fmt.Errorf("write node-persist record %s: %w", key, err)
		}
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("inspect node-persist record %s: %w", key, err)
	}
	if err := atomicCreate(target, body); err != nil {
		return fmt.Errorf("write node-persist record %s: %w", key, err)
	}
	return nil
}

// RemoveNodePersistRecord removes one node-persist key under the shared user
// storage lock. A missing key is a successful no-op, like node-persist's
// removeItem operation.
func RemoveNodePersistRecord(dataRoot, key string) error {
	if key == "" {
		return errors.New("node-persist record removal requires a key")
	}
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return fmt.Errorf("resolve data root: %w", err)
	}
	storageDir := filepath.Join(absoluteRoot, storageFolder)
	if _, err := os.Stat(storageDir); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect user storage directory: %w", err)
	}
	canonicalDir, err := canonicalPath(storageDir)
	if err != nil {
		return fmt.Errorf("resolve user storage directory: %w", err)
	}
	lock, err := acquireStorageLock(canonicalDir)
	if err != nil {
		return err
	}
	defer lock.Close()

	target := filepath.Join(storageDir, storeFilename(key))
	if err := os.Remove(target); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove node-persist record %s: %w", key, err)
	}
	if directory, err := os.Open(storageDir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

// NodePersistKeys returns the persisted keys that match a prefix, without
// interpreting their values. SillyTavern's node-persist keys() predicate
// operates on key names even when an account value is not an object.
func NodePersistKeys(dataRoot, prefix string) ([]string, error) {
	if dataRoot == "" {
		return nil, nil
	}
	absoluteRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve data root: %w", err)
	}
	entries, err := readStoreEntries(filepath.Join(absoluteRoot, storageFolder))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Key, prefix) {
			keys = append(keys, entry.Key)
		}
	}
	return keys, nil
}

// DirectoriesForUser returns the paths declared by SillyTavern's pinned
// USER_DIRECTORY_TEMPLATE for one user.
func DirectoriesForUser(dataRoot, handle string) (UserDirectories, error) {
	root, err := filepath.Abs(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve data root: %w", err)
	}
	userRoot := filepath.Join(root, handle)
	if err := ensureContained(root, userRoot); err != nil {
		return nil, fmt.Errorf("invalid user handle %q: %w", handle, err)
	}
	directories := make(UserDirectories, len(userDirectoryTemplate))
	for _, item := range userDirectoryTemplate {
		directories[item.key] = filepath.Join(userRoot, item.relative)
	}
	return directories, nil
}

// EnsureDirectories creates pinned public directories beneath installRoot and
// all user directories for the supplied persistent account handles.
func EnsureDirectories(installRoot, dataRoot string, handles []string) ([]UserDirectories, error) {
	root, err := filepath.Abs(installRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve install root: %w", err)
	}
	for _, item := range publicDirectoryTemplate {
		directory := filepath.Join(root, item.relative)
		if err := ensureContained(root, directory); err != nil {
			return nil, fmt.Errorf("invalid public directory %q: %w", item.key, err)
		}
		if err := ensureDirectoryIfMissing(directory); err != nil {
			return nil, fmt.Errorf("create public directory %s: %w", directory, err)
		}
	}

	directoriesList := make([]UserDirectories, 0, len(handles))
	for _, handle := range handles {
		directories, err := DirectoriesForUser(dataRoot, handle)
		if err != nil {
			return nil, err
		}
		for _, item := range userDirectoryTemplate {
			directory := directories[item.key]
			if err := ensureDirectoryIfMissing(directory); err != nil {
				return nil, fmt.Errorf("create %s directory for user %q: %w", item.key, handle, err)
			}
		}
		directoriesList = append(directoriesList, directories)
	}
	return directoriesList, nil
}

func ensureDirectoryIfMissing(directory string) error {
	if _, err := os.Stat(directory); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.MkdirAll(directory, 0o777)
}

func readStoreEntries(directory string) ([]storeEntry, error) {
	root, err := os.Open(directory)
	if err != nil {
		return nil, fmt.Errorf("read user storage directory: %w", err)
	}
	defer root.Close()
	files, err := root.ReadDir(-1)
	if err != nil {
		return nil, fmt.Errorf("read user storage directory: %w", err)
	}
	entries := make([]storeEntry, 0, len(files))
	for _, file := range files {
		if strings.HasPrefix(file.Name(), ".") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(directory, file.Name()))
		if err != nil {
			return nil, fmt.Errorf("read node-persist record %s: %w", file.Name(), err)
		}
		var entry storeEntry
		if err := json.Unmarshal(body, &entry); err != nil {
			return nil, fmt.Errorf("decode node-persist record %s: %w", file.Name(), err)
		}
		if entry.Key == "" {
			return nil, fmt.Errorf("node-persist record %s has no key", file.Name())
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func storeFilename(key string) string {
	digest := sha256.Sum256([]byte(key))
	return hex.EncodeToString(digest[:])
}

func acquireStorageLock(storageDir string) (*flock.Flock, error) {
	lockRoot := filepath.Join(os.TempDir(), lockFolderName)
	if err := os.MkdirAll(lockRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create user storage lock directory: %w", err)
	}
	key := storageDir
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	digest := sha256.Sum256([]byte(key))
	lockPath := filepath.Join(lockRoot, hex.EncodeToString(digest[:])+".lock")
	lock := flock.New(lockPath, flock.SetPermissions(0o600))
	if err := lock.Lock(); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("lock user storage %s: %w", storageDir, err)
	}
	return lock, nil
}

func atomicCreate(target string, body []byte) error {
	directory := filepath.Dir(target)
	var temporary *os.File
	for attempt := 0; attempt < 8; attempt++ {
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			return err
		}
		name := ".gotavern-user-" + hex.EncodeToString(token) + ".tmp"
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
		return errors.New("could not allocate a unique node-persist temporary file")
	}
	tempName := temporary.Name()
	defer os.Remove(tempName)
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
	if err := os.Link(tempName, target); err != nil {
		return err
	}
	if err := os.Remove(tempName); err != nil {
		return err
	}
	if dir, err := os.Open(directory); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func canonicalPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return filepath.Clean(absolute), nil
	}
	return resolved, nil
}

func ensureContained(root, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return err
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return errors.New("path escapes its root")
	}
	return nil
}
