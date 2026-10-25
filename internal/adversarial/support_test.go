package adversarial

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/app"
)

func writeText(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatalf("release the reserved port: %v", err)
	}
	return port
}

// canonicalLockKey mirrors the canonicalisation the product applies before it
// hashes a path for a lock file. It is only used together with a faithfulness
// assertion (the product must have created exactly this file), so a drift in
// the mirror can never make a case pass by not contending.
func canonicalLockKey(value string) (string, error) {
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		return resolved, nil
	}
	if parent, err := filepath.EvalSymlinks(filepath.Dir(absolute)); err == nil {
		return filepath.Join(parent, filepath.Base(absolute)), nil
	}
	return filepath.Clean(absolute), nil
}

// productLockPath mirrors internal/configinit/config.go:157-167,
// internal/startup/storage.go:428-438 and internal/startup/content.go:371-381.
func productLockPath(folder, key string) string {
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	digest := sha256.Sum256([]byte(key))
	return filepath.Join(os.TempDir(), folder, hex.EncodeToString(digest[:])+".lock")
}

// startProduct runs the real boot. Every argument is explicit so a case can
// never depend on the test process's own working directory or $HOME.
func startProduct(installRoot, workDir, dataRoot string, port int, waitBeforeMove func(time.Duration), extra ...string) (*app.RunningServer, error) {
	args := []string{"--dataRoot", dataRoot}
	args = append(args, extra...)
	return startProductArgs(installRoot, workDir, port, waitBeforeMove, args...)
}

// startProductArgs is startProduct without a forced --dataRoot, so a case can
// measure what a config file's own relative dataRoot does.
func startProductArgs(installRoot, workDir string, port int, waitBeforeMove func(time.Duration), args ...string) (*app.RunningServer, error) {
	all := append([]string{"--port", strconv.Itoa(port)}, args...)
	return app.Start(app.StartOptions{
		Args:                     all,
		WorkingDirectory:         workDir,
		InstallRoot:              installRoot,
		WaitBeforeLegacyDataMove: waitBeforeMove,
	})
}

// startProductGlobal boots in global mode, which is the only mode that reads
// $HOME for the data root.
func startProductGlobal(installRoot, workDir string, port int) (*app.RunningServer, error) {
	return app.Start(app.StartOptions{
		Args:                     []string{"--port", strconv.Itoa(port)},
		WorkingDirectory:         workDir,
		InstallRoot:              installRoot,
		ForceGlobalMode:          boolPointer(true),
		WaitBeforeLegacyDataMove: noLegacyWait,
	})
}

func noLegacyWait(time.Duration) {}

func boolPointer(value bool) *bool { return &value }

// treeDigest hashes every regular file under root (path, mode, bytes), so a boot
// that mutates the user's tree cannot pass an equality check.
func treeDigest(root string) (string, error) {
	digest := sha256.New()
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if info.IsDir() {
			_, _ = digest.Write([]byte("dir " + relative + "\n"))
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, _ = digest.Write([]byte("file " + relative + " " + info.Mode().String() + "\n"))
		_, _ = digest.Write(body)
		return nil
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
