package startup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
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
		SeededContent []seededObservation `json:"seededContent"`
	} `json:"filesystem"`
}

type directoryObservation struct {
	Key  string `json:"key"`
	Path string `json:"path"`
}

type seededObservation struct {
	Path   string `json:"path"`
	Type   string `json:"type"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
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

func TestSeedDefaultContentMatchesPinnedNodeFreshStart(t *testing.T) {
	fixture := readStartupOracle(t)
	if len(fixture.Filesystem.SeededContent) < 100 {
		t.Fatalf("pinned Node fixture has only %d seeded-content entries", len(fixture.Filesystem.SeededContent))
	}
	installRoot := filepath.Join(t.TempDir(), "install")
	dataRoot := filepath.Join(t.TempDir(), "data")
	handles, err := InitializeUserStorage(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	directories, err := EnsureDirectories(installRoot, dataRoot, handles)
	if err != nil {
		t.Fatal(err)
	}
	result, err := SeedDefaultContent(dataRoot, directories, SeedOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.GlobalContentAdded || !result.AnyContentAdded || len(result.UserContentAdded) != 1 || !result.UserContentAdded[0] {
		t.Fatalf("fresh seeding result = %+v, want global and one user copy", result)
	}

	actual, err := snapshotSeededContent(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, fixture.Filesystem.SeededContent) {
		gotJSON, _ := json.MarshalIndent(actual, "", "  ")
		wantJSON, _ := json.MarshalIndent(fixture.Filesystem.SeededContent, "", "  ")
		index := firstJSONDifference(gotJSON, wantJSON)
		start := max(index-120, 0)
		gotEnd := min(index+400, len(gotJSON))
		wantEnd := min(index+400, len(wantJSON))
		t.Fatalf("seeded content differs from the pinned Node startup at JSON byte %d:\n got: %s\nwant: %s", index, gotJSON[start:gotEnd], wantJSON[start:wantEnd])
	}

	second, err := SeedDefaultContent(dataRoot, directories, SeedOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if second.AnyContentAdded || second.GlobalContentAdded || (len(second.UserContentAdded) == 1 && second.UserContentAdded[0]) {
		t.Fatalf("second seeding unexpectedly added content: %+v", second)
	}
}

func TestSeedDefaultContentSkipAndExistingSettings(t *testing.T) {
	installRoot := filepath.Join(t.TempDir(), "install")
	dataRoot := filepath.Join(t.TempDir(), "data")
	handles, err := InitializeUserStorage(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	directories, err := EnsureDirectories(installRoot, dataRoot, handles)
	if err != nil {
		t.Fatal(err)
	}
	result, err := SeedDefaultContent(dataRoot, directories, SeedOptions{SkipContentCheck: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.AnyContentAdded || result.GlobalContentAdded {
		t.Fatalf("skipContentCheck seeded content: %+v", result)
	}
	for _, file := range []string{
		filepath.Join(dataRoot, "content.log"),
		filepath.Join(directories[0]["root"], "content.log"),
		filepath.Join(directories[0]["root"], "settings.json"),
	} {
		if _, err := os.Stat(file); !os.IsNotExist(err) {
			t.Fatalf("skipContentCheck created %s", file)
		}
	}

	settingsPath := filepath.Join(directories[0]["root"], "settings.json")
	customSettings := []byte("{\"userOwned\":true}")
	if err := os.WriteFile(settingsPath, customSettings, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err = SeedDefaultContent(dataRoot, directories, SeedOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.GlobalContentAdded || !result.UserContentAdded[0] {
		t.Fatalf("seeding with an existing settings override returned %+v", result)
	}
	got, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(customSettings) {
		t.Fatalf("existing settings override changed to %q", got)
	}
	contentLog, err := os.ReadFile(filepath.Join(directories[0]["root"], "content.log"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(contentLog), "\n")
	if len(lines) == 0 || lines[0] != "settings.json" {
		t.Fatalf("content log does not record the existing settings target first: %q", contentLog)
	}
	result, err = SeedDefaultContent(dataRoot, directories, SeedOptions{ForceCategories: []string{"settings"}})
	if err != nil {
		t.Fatal(err)
	}
	if result.AnyContentAdded {
		t.Fatalf("forcing an existing settings item unexpectedly copied content: %+v", result)
	}
	contentLog, err = os.ReadFile(filepath.Join(directories[0]["root"], "content.log"))
	if err != nil {
		t.Fatal(err)
	}
	lines = strings.Split(string(contentLog), "\n")
	if lines[len(lines)-1] != "settings.json" {
		t.Fatalf("forced settings category did not append the upstream duplicate log entry: %q", contentLog)
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

func snapshotSeededContent(root string) ([]seededObservation, error) {
	entries := make([]seededObservation, 0)
	err := filepath.WalkDir(root, func(file string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if !isSeededPath(relative) {
			if entry.IsDir() {
				return nil
			}
			return nil
		}
		if entry.IsDir() {
			entries = append(entries, seededObservation{Path: relative, Type: "directory"})
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("unexpected non-regular seeded path %s", relative)
		}
		body, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(body)
		entries = append(entries, seededObservation{
			Path:   relative,
			Type:   "file",
			Bytes:  len(body),
			SHA256: hex.EncodeToString(digest[:]),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Path < entries[right].Path })
	return entries, nil
}

func isSeededPath(relative string) bool {
	if relative == "content.log" || relative == "default-user/content.log" {
		return true
	}
	if relative == "_css" || strings.HasPrefix(relative, "_css/") || relative == "_errors" || strings.HasPrefix(relative, "_errors/") {
		return true
	}
	if !strings.HasPrefix(relative, "default-user/") || relative == "default-user/stats.json" {
		return false
	}
	return relative != "default-user/backups" && !strings.HasPrefix(relative, "default-user/backups/") && !strings.HasSuffix(relative, "/.migrated")
}

func firstJSONDifference(left, right []byte) int {
	limit := min(len(left), len(right))
	for index := 0; index < limit; index++ {
		if left[index] != right[index] {
			return index
		}
	}
	return limit
}

func TestUpdateNodePersistRecordPreservesFieldsAndSerializesConcurrentUpdates(t *testing.T) {
	dataRoot := t.TempDir()
	storageDir := filepath.Join(dataRoot, storageFolder)
	if err := os.MkdirAll(storageDir, 0o700); err != nil {
		t.Fatal(err)
	}
	key := "user:recovery-test"
	target := filepath.Join(storageDir, storeFilename(key))
	original := []byte(`{"key":"user:recovery-test","value":{"handle":"recovery-test","unknown":{"keep":[1,true]}},"unknownRecordField":"preserved","ttl":1700000000000}`)
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}

	const updates = 12
	var wait sync.WaitGroup
	errors := make(chan error, updates)
	for range updates {
		wait.Add(1)
		go func() {
			defer wait.Done()
			err := UpdateNodePersistRecord(dataRoot, key, func(raw json.RawMessage) (json.RawMessage, error) {
				var fields map[string]json.RawMessage
				if err := json.Unmarshal(raw, &fields); err != nil {
					return nil, err
				}
				var count int
				if encoded := fields["updates"]; len(encoded) > 0 {
					if err := json.Unmarshal(encoded, &count); err != nil {
						return nil, err
					}
				}
				encoded, err := json.Marshal(count + 1)
				if err != nil {
					return nil, err
				}
				fields["updates"] = encoded
				return json.Marshal(fields)
			})
			if err != nil {
				errors <- err
			}
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}

	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(body, &record); err != nil {
		t.Fatal(err)
	}
	if got := string(record["unknownRecordField"]); got != `"preserved"` {
		t.Errorf("unknown node-persist record field = %s", got)
	}
	if got := string(record["ttl"]); got != "1700000000000" {
		t.Errorf("node-persist TTL = %s", got)
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(record["value"], &value); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := json.Unmarshal(value["updates"], &count); err != nil {
		t.Fatal(err)
	}
	if count != updates {
		t.Errorf("concurrent record updates = %d, want %d", count, updates)
	}
	if got := string(value["unknown"]); got != `{"keep":[1,true]}` {
		t.Errorf("unknown user field = %s", got)
	}
}
