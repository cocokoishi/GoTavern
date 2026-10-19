package startup

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type cookieSecretOracle struct {
	Scenarios map[string]cookieSecretObservation `json:"scenarios"`
}

type cookieSecretObservation struct {
	FileBytes            int    `json:"fileBytes"`
	DecodedRandomBytes   int    `json:"decodedRandomBytes"`
	SHA256               string `json:"sha256"`
	ReturnedMatchesFile  bool   `json:"returnedMatchesFile"`
	PreexistingPreserved bool   `json:"preexistingBytesPreserved"`
}

func readCookieSecretOracle(t *testing.T) cookieSecretOracle {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-cookie-secret.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture cookieSecretOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestInitializeCookieSecretMatchesPinnedNode(t *testing.T) {
	fixture := readCookieSecretOracle(t)
	secret, result, err := InitializeCookieSecret(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if result != (CookieSecretResult{Generated: true}) {
		t.Fatalf("generated secret result = %+v", result)
	}
	decoded, err := base64.StdEncoding.DecodeString(secret)
	if err != nil {
		t.Fatalf("generated secret is not base64: %v", err)
	}
	generated := fixture.Scenarios["generated"]
	if len(secret) != generated.FileBytes || len(decoded) != generated.DecodedRandomBytes || !generated.ReturnedMatchesFile {
		t.Fatalf("generated secret observation = %d chars/%d random bytes; Node oracle = %+v", len(secret), len(decoded), generated)
	}

	dataRoot := t.TempDir()
	secretPath := filepath.Join(dataRoot, "cookie-secret.txt")
	legacy := "pinned-legacy-cookie-secret"
	secret, result, err = InitializeCookieSecret(dataRoot, legacy)
	if err != nil {
		t.Fatal(err)
	}
	if secret != legacy || result != (CookieSecretResult{Migrated: true}) {
		t.Fatalf("legacy migration returned (%q, %+v)", secret, result)
	}
	verifyCookieSecretFixture(t, secretPath, fixture.Scenarios["migrated"])

	dataRoot = t.TempDir()
	secretPath = filepath.Join(dataRoot, "cookie-secret.txt")
	if err := os.WriteFile(secretPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	legacy = "pinned-empty-file-legacy-secret"
	secret, result, err = InitializeCookieSecret(dataRoot, legacy)
	if err != nil {
		t.Fatal(err)
	}
	if secret != legacy || result != (CookieSecretResult{Migrated: true}) {
		t.Fatalf("empty-file legacy migration returned (%q, %+v)", secret, result)
	}
	verifyCookieSecretFixture(t, secretPath, fixture.Scenarios["emptyFileMigrated"])

	dataRoot = t.TempDir()
	secretPath = filepath.Join(dataRoot, "cookie-secret.txt")
	if err := os.WriteFile(secretPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	secret, result, err = InitializeCookieSecret(dataRoot, "")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Generated {
		t.Fatalf("empty-file generation result = %+v", result)
	}
	decoded, err = base64.StdEncoding.DecodeString(secret)
	if err != nil || len(secret) != fixture.Scenarios["emptyFileGenerated"].FileBytes || len(decoded) != fixture.Scenarios["emptyFileGenerated"].DecodedRandomBytes {
		t.Fatalf("empty-file generated secret = %d chars/%d random bytes, decode error = %v", len(secret), len(decoded), err)
	}
	verifyCookieSecretFixture(t, secretPath, fixture.Scenarios["emptyFileGenerated"])

	dataRoot = t.TempDir()
	secretPath = filepath.Join(dataRoot, "cookie-secret.txt")
	existing := []byte("existing-cookie-secret")
	if err := os.WriteFile(secretPath, existing, 0o600); err != nil {
		t.Fatal(err)
	}
	secret, result, err = InitializeCookieSecret(dataRoot, "ignored-legacy-secret")
	if err != nil {
		t.Fatal(err)
	}
	if secret != string(existing) || result != (CookieSecretResult{Existing: true}) {
		t.Fatalf("existing secret returned (%q, %+v)", secret, result)
	}
	verifyCookieSecretFixture(t, secretPath, fixture.Scenarios["existing"])

	second, secondResult, err := InitializeCookieSecret(dataRoot, "different-legacy-secret")
	if err != nil {
		t.Fatal(err)
	}
	if second != secret || secondResult != (CookieSecretResult{Existing: true}) {
		t.Fatalf("second initialization returned (%q, %+v), want existing secret", second, secondResult)
	}
}

func verifyCookieSecretFixture(t *testing.T, path string, expected cookieSecretObservation) {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	if len(body) != expected.FileBytes || (expected.SHA256 != "" && hex.EncodeToString(digest[:]) != expected.SHA256) || !expected.ReturnedMatchesFile {
		t.Fatalf("cookie-secret file observation = %d bytes, sha256 %s; Node oracle = %+v", len(body), hex.EncodeToString(digest[:]), expected)
	}
}

func TestInitializeCookieSecretSerializesConcurrentGeneration(t *testing.T) {
	dataRoot := t.TempDir()
	const callers = 8
	secrets := make(chan string, callers)
	results := make(chan CookieSecretResult, callers)
	errors := make(chan error, callers)
	var wait sync.WaitGroup
	for index := range callers {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			secret, result, err := InitializeCookieSecret(dataRoot, fmt.Sprintf("legacy-secret-%d", index))
			if err != nil {
				errors <- err
				return
			}
			secrets <- secret
			results <- result
		}(index)
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	close(secrets)
	close(results)
	var first string
	for secret := range secrets {
		if first == "" {
			first = secret
		} else if secret != first {
			t.Fatalf("concurrent secret values differ: %q vs %q", secret, first)
		}
	}
	migrated := 0
	existing := 0
	for result := range results {
		if result.Migrated {
			migrated++
		}
		if result.Existing {
			existing++
		}
	}
	if migrated != 1 || existing != callers-1 {
		t.Fatalf("concurrent initializer outcomes: migrated=%d existing=%d", migrated, existing)
	}
}
