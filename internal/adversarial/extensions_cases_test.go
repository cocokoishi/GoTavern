package adversarial

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeExecutable(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write executable %s: %v", path, err)
	}
}

// extensionsCases proves P0-C from the observable side that ARCHITECTURE 34.3
// now rules on: the inherited keys are reported and never acted on.
func extensionsCases(t *testing.T) []caseSpec {
	t.Helper()

	installRoot := t.TempDir()
	workDir := t.TempDir()
	dataRoot := t.TempDir()
	writeText(t, filepath.Join(workDir, "config.yaml"), "listen: false\nextensions:\n  autoUpdate: true\n")
	extensionDir := filepath.Join(installRoot, "public", "scripts", "extensions", "third-party", "probe-ext")
	writeText(t, filepath.Join(extensionDir, "manifest.json"), `{"display_name":"Probe","js":"index.js","auto_update":true}`)
	writeText(t, filepath.Join(extensionDir, "index.js"), "// probe extension body\n")

	shimDir := t.TempDir()
	recorder := filepath.Join(t.TempDir(), "git-invocations.log")
	writeExecutable(t, filepath.Join(shimDir, "git"),
		"#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$GOTAVERN_GIT_RECORDER\"\nexit 0\n")

	port := freePort(t)

	// The GoTavern-owned key does not exist yet; the ruling says it is the only
	// input that may enable automatic updating, resolved strictly.
	strictKeyWork := t.TempDir()
	writeText(t, filepath.Join(strictKeyWork, "config.yaml"), "listen: false\ngotavern:\n  autoUpdateExtensions: \"yes\"\n")

	return []caseSpec{
		{
			id:        "extensions.boot-runs-no-git",
			checklist: "autoupdate.inherited",
			invariant: "ARCHITECTURE 34.3 / rule 25: a stock tree whose config says extensions.autoUpdate: true performs zero updater egress and mutates no extension on boot",
			run: func() caseResult {
				if runtime.GOOS == "windows" {
					return notApplicable("the git recorder is a POSIX shell script; a Windows runner cannot exercise it")
				}
				previousPath, hadPath := os.LookupEnv("PATH")
				previousRecorder, hadRecorder := os.LookupEnv("GOTAVERN_GIT_RECORDER")
				if err := os.Setenv("PATH", shimDir+string(os.PathListSeparator)+previousPath); err != nil {
					return violation("prepend the git shim: %v", err)
				}
				if err := os.Setenv("GOTAVERN_GIT_RECORDER", recorder); err != nil {
					return violation("set the recorder: %v", err)
				}
				defer func() {
					if hadPath {
						_ = os.Setenv("PATH", previousPath)
					} else {
						_ = os.Unsetenv("PATH")
					}
					if hadRecorder {
						_ = os.Setenv("GOTAVERN_GIT_RECORDER", previousRecorder)
					} else {
						_ = os.Unsetenv("GOTAVERN_GIT_RECORDER")
					}
				}()

				// Faithfulness: the recorder must be able to see a git call, or an
				// empty log after boot would prove nothing.
				if err := exec.Command("git", "--adversarial-probe").Run(); err != nil {
					return violation("the git shim did not run: %v", err)
				}
				probeLog, err := os.ReadFile(recorder)
				if err != nil || !strings.Contains(string(probeLog), "--adversarial-probe") {
					return violation("the git recorder did not record a known invocation (%v), so an empty log after boot is not evidence", err)
				}
				if err := os.Remove(recorder); err != nil {
					return violation("clear the recorder: %v", err)
				}

				before, err := treeDigest(filepath.Join(installRoot, "public", "scripts", "extensions"))
				if err != nil {
					return violation("hash the extension tree before boot: %v", err)
				}
				running, startErr := startProduct(installRoot, workDir, dataRoot, port, noLegacyWait)
				if startErr != nil {
					return violation("boot with a stock auto-update config failed: %v", startErr)
				}
				_ = running.Close(context.Background())
				after, err := treeDigest(filepath.Join(installRoot, "public", "scripts", "extensions"))
				if err != nil {
					return violation("hash the extension tree after boot: %v", err)
				}
				if before != after {
					return violation("boot mutated the extension tree under a config that says autoUpdate: true (digest %s -> %s)", before[:12], after[:12])
				}
				if recorded, readErr := os.ReadFile(recorder); readErr == nil && strings.TrimSpace(string(recorded)) != "" {
					return violation("boot ran git: %s", strings.TrimSpace(string(recorded)))
				}
				return okResult("boot ran no git and left the extension tree byte-identical")
			},
		},
		{
			id:        "extensions.gotavern-key-strict",
			checklist: "autoupdate.inherited",
			invariant: "ARCHITECTURE 34.3: only gotavern.autoUpdateExtensions, resolved strictly (a non-boolean string is false), may enable automatic updating",
			run: func() caseResult {
				if clean, why := environmentIsClean(); !clean {
					return notApplicable("%s", why)
				}
				result, err := resolveProductOptions(strictKeyWork)
				if err != nil {
					return violation("resolving the GoTavern-key config failed: %v", err)
				}
				reported, explicit := reportedAutoUpdate(result)
				if reported {
					return violation("gotavern.autoUpdateExtensions: \"yes\" must not enable updating, but enable_extensions_auto_update reports true (explicit=%t): the inherited extensions.autoUpdate default is still the input", explicit)
				}
				return okResult("reports false")
			},
		},
	}
}
