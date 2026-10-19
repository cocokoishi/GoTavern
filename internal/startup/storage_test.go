package startup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
)

type startupOracle struct {
	Filesystem struct {
		DataRoot []struct {
			Path  string `json:"path"`
			Bytes int    `json:"bytes"`
		} `json:"dataRoot"`
		UserStore struct {
			Observed    bool `json:"observed"`
			UserRecords []struct {
				Path   string         `json:"path"`
				Record map[string]any `json:"record"`
			} `json:"userRecords"`
		} `json:"userStore"`
		StartupDirectories struct {
			User   []directoryObservation `json:"user"`
			Public []directoryObservation `json:"public"`
		} `json:"startupDirectories"`
	} `json:"filesystem"`
}

type directoryObservation struct {
	Key  string `json:"key"`
	Path string `json:"path"`
}

func readStartupOracle(t *testing.T) startupOracle {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-fresh-start.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture startupOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if !fixture.Filesystem.UserStore.Observed || len(fixture.Filesystem.UserStore.UserRecords) != 1 {
		t.Fatal("pinned Node fixture does not contain one observed fresh-install user record")
	}
	return fixture
}

func TestInitializeUserStorageMatchesPinnedNodePersistRecord(t *testing.T) {
	fixture := readStartupOracle(t)
	dataRoot := filepath.Join(t.TempDir(), "data")
	handles, err := InitializeUserStorage(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(handles, []string{defaultHandle}) {
		t.Fatalf("user handles = %#v, want [%q]", handles, defaultHandle)
	}

	want := fixture.Filesystem.UserStore.UserRecords[0]
	if want.Path != filepath.ToSlash(filepath.Join(storageFolder, storeFilename(userKeyPrefix+defaultHandle))) {
		t.Fatalf("Node oracle storage path = %q, does not match the node-persist key digest", want.Path)
	}
	actualPath := filepath.Join(dataRoot, filepath.FromSlash(want.Path))
	actualBytes, err := os.ReadFile(actualPath)
	if err != nil {
		t.Fatal(err)
	}
	var actual map[string]any
	if err := json.Unmarshal(actualBytes, &actual); err != nil {
		t.Fatal(err)
	}
	userValue, ok := actual["value"].(map[string]any)
	if !ok {
		t.Fatalf("default record value has type %T, want object", actual["value"])
	}
	created, ok := userValue["created"].(float64)
	if !ok || created <= 0 {
		t.Fatalf("default user created timestamp = %#v, want positive number", userValue["created"])
	}
	userValue["created"] = "<timestamp>"
	if !reflect.DeepEqual(actual, want.Record) {
		gotJSON, _ := json.MarshalIndent(actual, "", "  ")
		wantJSON, _ := json.MarshalIndent(want.Record, "", "  ")
		t.Fatalf("node-persist record differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
	}
	for _, observation := range fixture.Filesystem.DataRoot {
		if observation.Path == filepath.ToSlash(want.Path) && len(actualBytes) != observation.Bytes {
			t.Fatalf("node-persist record length = %d, Node oracle has %d", len(actualBytes), observation.Bytes)
		}
	}

	second, err := InitializeUserStorage(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(second, handles) {
		t.Fatalf("second initialization handles = %#v, want %#v", second, handles)
	}
	secondBytes, err := os.ReadFile(actualPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(secondBytes) != string(actualBytes) {
		t.Fatal("second initialization rewrote the existing account record")
	}
}

func TestInitializeUserStoragePreservesExistingNodeRecords(t *testing.T) {
	dataRoot := filepath.Join(t.TempDir(), "data")
	storageDir := filepath.Join(dataRoot, storageFolder)
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	userKey := userKeyPrefix + "custom"
	avatarKey := "avatar:custom"
	userDigest := sha256.Sum256([]byte(userKey))
	avatarDigest := sha256.Sum256([]byte(avatarKey))
	userPath := filepath.Join(storageDir, hex.EncodeToString(userDigest[:]))
	avatarPath := filepath.Join(storageDir, hex.EncodeToString(avatarDigest[:]))
	userBytes := []byte(`{"key":"user:custom","value":{"handle":"custom","unknown":{"kept":true}},"customField":"preserve"}`)
	avatarBytes := []byte(`{"key":"avatar:custom","value":"data:image/png;base64,AA==","ttl":null}`)
	if err := os.WriteFile(userPath, userBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(avatarPath, avatarBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	handles, err := InitializeUserStorage(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(handles, []string{"custom"}) {
		t.Fatalf("user handles = %#v, want [custom]", handles)
	}
	for path, want := range map[string][]byte{userPath: userBytes, avatarPath: avatarBytes} {
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(want) {
			t.Fatalf("existing record %s changed:\n got: %s\nwant: %s", path, got, want)
		}
	}
	if _, err := os.Stat(filepath.Join(storageDir, storeFilename(userKeyPrefix+defaultHandle))); !os.IsNotExist(err) {
		t.Fatal("default account was created even though a user record already exists")
	}
}

func TestInitializeUserStorageDoesNotWriteAroundMalformedRecords(t *testing.T) {
	dataRoot := filepath.Join(t.TempDir(), "data")
	storageDir := filepath.Join(dataRoot, storageFolder)
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	corruptPath := filepath.Join(storageDir, "corrupt")
	if err := os.WriteFile(corruptPath, []byte(`{"key":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := InitializeUserStorage(dataRoot); err == nil {
		t.Fatal("expected malformed node-persist data to fail initialization")
	}
	if _, err := os.Stat(filepath.Join(storageDir, storeFilename(userKeyPrefix+defaultHandle))); !os.IsNotExist(err) {
		t.Fatal("default account was written despite a malformed existing record")
	}
	got, err := os.ReadFile(corruptPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"key":` {
		t.Fatalf("malformed record changed to %q", got)
	}
}

func TestEnsureDirectoriesMatchesPinnedDirectoryTemplate(t *testing.T) {
	fixture := readStartupOracle(t)
	installRoot := filepath.Join(t.TempDir(), "install")
	dataRoot := filepath.Join(t.TempDir(), "data")
	directories, err := EnsureDirectories(installRoot, dataRoot, []string{defaultHandle})
	if err != nil {
		t.Fatal(err)
	}
	if len(directories) != 1 {
		t.Fatalf("directories returned for %d users, want one", len(directories))
	}
	for _, observation := range fixture.Filesystem.StartupDirectories.User {
		actual, ok := directories[0][observation.Key]
		if !ok {
			t.Fatalf("missing pinned user directory property %q", observation.Key)
		}
		if got := filepath.ToSlash(mustRel(t, dataRoot, actual)); got != observation.Path {
			t.Errorf("user directory %q = %q, Node oracle has %q", observation.Key, got, observation.Path)
		}
		if info, err := os.Stat(actual); err != nil || !info.IsDir() {
			t.Errorf("user directory %q was not created: stat=%v", observation.Key, err)
		}
	}
	if len(directories[0]) != len(fixture.Filesystem.StartupDirectories.User) {
		t.Fatalf("user directory properties = %d, Node oracle has %d", len(directories[0]), len(fixture.Filesystem.StartupDirectories.User))
	}
	for _, observation := range fixture.Filesystem.StartupDirectories.Public {
		actual := filepath.Join(installRoot, filepath.FromSlash(observation.Path))
		if info, err := os.Stat(actual); err != nil || !info.IsDir() {
			t.Errorf("public directory %q was not created: stat=%v", observation.Key, err)
		}
	}
}

func TestInitializeUserStorageIsProcessSafe(t *testing.T) {
	dataRoot := filepath.Join(t.TempDir(), "data")
	const callers = 10
	var wait sync.WaitGroup
	errors := make(chan error, callers)
	for range callers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			handles, err := InitializeUserStorage(dataRoot)
			if err != nil {
				errors <- err
				return
			}
			if len(handles) != 1 || handles[0] != defaultHandle {
				errors <- fmt.Errorf("unexpected handles: %v", handles)
			}
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	entries, err := os.ReadDir(filepath.Join(dataRoot, storageFolder))
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ".") {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("concurrent initialization left %d account-store entries, want one", count)
	}
}

func TestDirectoriesForUserRejectsEscapingHandles(t *testing.T) {
	handles := []string{"../outside"}
	if runtime.GOOS == "windows" {
		handles = append(handles, `..\outside`)
	}
	for _, handle := range handles {
		if _, err := DirectoriesForUser(t.TempDir(), handle); err == nil {
			t.Errorf("accepted escaping user handle %q", handle)
		}
	}
}

func mustRel(t *testing.T, root, target string) string {
	t.Helper()
	relative, err := filepath.Rel(root, target)
	if err != nil {
		t.Fatal(err)
	}
	return relative
}
