package adversarial

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/configinit"
	"github.com/cocokoishi/gotavern/internal/server"
)

// environmentIsClean reports whether a case that resolves command-line options
// can trust the config file alone. A SILLYTAVERN_* environment variable wins
// over the file (internal/commandline/options.go:250 and getConfigValue), so a
// case would silently measure the runner's environment instead of its fixture.
func environmentIsClean() (bool, string) {
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "SILLYTAVERN_") {
			return false, "the process environment carries " + strings.SplitN(entry, "=", 2)[0] + ", which overrides the config file under test"
		}
	}
	return true, ""
}

func resolveProductOptions(workDir string, extraArgs ...string) (commandline.CommandLineResult, error) {
	return commandline.ResolveCommandLine(commandline.ResolveOptions{
		Args:             extraArgs,
		WorkingDirectory: workDir,
		ServerDirectory:  workDir,
	})
}

// reportedAutoUpdate is the value /api/settings/get would report for
// enable_extensions_auto_update (internal/server/settings_get.go:70 reports
// runtime.options.ExtensionsAutoUpdate and falls back to TRUE when it is nil).
func reportedAutoUpdate(result commandline.CommandLineResult) (bool, bool) {
	options := server.HTTPHandlerOptionsFromCommandLine(result)
	if options.ExtensionsAutoUpdate == nil {
		return true, false
	}
	return *options.ExtensionsAutoUpdate, true
}

func configCases(t *testing.T) []caseSpec {
	t.Helper()

	badYAMLDir := t.TempDir()
	badYAMLPath := filepath.Join(badYAMLDir, "config.yaml")
	badYAMLBody := "listen: false\nbroken: [1, 2\n"
	writeText(t, badYAMLPath, badYAMLBody)

	truncatedDir := t.TempDir()
	truncatedPath := filepath.Join(truncatedDir, "config.yaml")
	truncatedBody := "listen: false\ndataRoot: \"unterminated\n"
	writeText(t, truncatedPath, truncatedBody)

	nullDir := t.TempDir()
	writeText(t, filepath.Join(nullDir, "config.yaml"), "listen: false\nextensions:\n  autoUpdate: null\n")

	unparsedDir := t.TempDir()
	writeText(t, filepath.Join(unparsedDir, "config.yaml"), "listen: false\nextensions:\n  autoUpdate: \"maybe\"\n")

	legacyDir := t.TempDir()
	writeText(t, filepath.Join(legacyDir, "config.yaml"), "listen: false\nenableExtensionsAutoUpdate: false\n")

	inheritedDir := t.TempDir()
	writeText(t, filepath.Join(inheritedDir, "config.yaml"), "listen: false\nextensions:\n  autoUpdate: true\n")

	freshDir := t.TempDir()

	rewriteDir := t.TempDir()
	rewritePath := filepath.Join(rewriteDir, "config.yaml")
	rewriteBody := "listen: false\nport: 8000\nsomeFutureSection:\n    keptValue: 41\n"
	writeText(t, rewritePath, rewriteBody)

	readOnlyDir := t.TempDir()
	readOnlyPath := filepath.Join(readOnlyDir, "config.yaml")
	readOnlyBody := "listen: false\nport: 8000\n"
	writeText(t, readOnlyPath, readOnlyBody)

	missingParentDir := t.TempDir()
	missingParentConfig := filepath.Join(missingParentDir, "absent", "nested", "config.yaml")

	staleLockDir := t.TempDir()
	staleLockPath := filepath.Join(staleLockDir, "config.yaml")
	writeText(t, staleLockPath, "listen: false\nport: 8000\n")

	return []caseSpec{
		{
			id:        "config.bad-yaml",
			checklist: "bad.yaml",
			invariant: "a config that does not parse is reported and left byte-identical (rule 12/27: no write on the error path)",
			run: func() caseResult {
				_, err := configinit.Initialize(badYAMLPath)
				after, readErr := os.ReadFile(badYAMLPath)
				if readErr != nil {
					return violation("the config disappeared after a parse failure: %v", readErr)
				}
				if err == nil {
					return violation("malformed YAML was accepted; the file is now %q", string(after))
				}
				if string(after) != badYAMLBody {
					return violation("the malformed config was rewritten (%q -> %q) despite the error", badYAMLBody, string(after))
				}
				return okResult("refused with %v and the bytes are unchanged", err)
			},
		},
		{
			id:        "config.truncated-yaml",
			checklist: "truncated.yaml",
			invariant: "a truncated config is reported and left byte-identical (rule 12/27)",
			run: func() caseResult {
				_, err := configinit.Initialize(truncatedPath)
				after, readErr := os.ReadFile(truncatedPath)
				if readErr != nil {
					return violation("the config disappeared after a parse failure: %v", readErr)
				}
				if err == nil {
					return violation("truncated YAML was accepted; the file is now %q", string(after))
				}
				if string(after) != truncatedBody {
					return violation("the truncated config was rewritten (%q -> %q) despite the error", truncatedBody, string(after))
				}
				return okResult("refused with %v and the bytes are unchanged", err)
			},
		},
		{
			id:        "config.autoupdate-null",
			checklist: "autoupdate.null",
			invariant: "extensions.autoUpdate: null resolves to OFF (rule 26: an ambiguous input never enables updating)",
			run: func() caseResult {
				if clean, why := environmentIsClean(); !clean {
					return notApplicable("%s", why)
				}
				result, err := resolveProductOptions(nullDir)
				if err != nil {
					return violation("resolving a config with autoUpdate: null failed: %v", err)
				}
				reported, explicit := reportedAutoUpdate(result)
				if reported {
					return violation("autoUpdate: null reports enable_extensions_auto_update=true (explicit=%t); a null must not enable updating", explicit)
				}
				return okResult("reports false (explicit=%t)", explicit)
			},
		},
		{
			id:        "config.autoupdate-unparsed-value",
			checklist: "autoupdate.null",
			invariant: "an unparseable extensions.autoUpdate value resolves to OFF (rule 26: 'unparsed' is an OFF input)",
			run: func() caseResult {
				if clean, why := environmentIsClean(); !clean {
					return notApplicable("%s", why)
				}
				result, err := resolveProductOptions(unparsedDir)
				if err != nil {
					return violation("resolving a config with autoUpdate: \"maybe\" failed: %v", err)
				}
				reported, explicit := reportedAutoUpdate(result)
				if reported {
					return violation("autoUpdate: \"maybe\" reports enable_extensions_auto_update=true; a non-boolean string is JS-truthy so it turns updating ON (explicit=%t)", explicit)
				}
				return okResult("reports false (explicit=%t)", explicit)
			},
		},
		{
			id:        "config.autoupdate-inherited-true",
			checklist: "autoupdate.inherited",
			invariant: "ARCHITECTURE 34.3: the inherited keys are reported and never acted on, so a stock config saying autoUpdate: true must not enable automatic updating",
			run: func() caseResult {
				if clean, why := environmentIsClean(); !clean {
					return notApplicable("%s", why)
				}
				result, err := resolveProductOptions(inheritedDir)
				if err != nil {
					return violation("resolving a stock config failed: %v", err)
				}
				reported, explicit := reportedAutoUpdate(result)
				if reported {
					return violation("a stock config with extensions.autoUpdate: true reports enable_extensions_auto_update=true, so the inherited key is still an input (explicit=%t)", explicit)
				}
				return okResult("reports false")
			},
		},
		{
			id:        "config.autoupdate-fresh-install",
			checklist: "autoupdate.inherited",
			invariant: "ARCHITECTURE 34.3: a FRESH install writes pinned's config, whose extensions.autoUpdate is true, and must still report automatic updating as off",
			run: func() caseResult {
				if clean, why := environmentIsClean(); !clean {
					return notApplicable("%s", why)
				}
				result, err := resolveProductOptions(freshDir)
				if err != nil {
					return violation("resolving a fresh install failed: %v", err)
				}
				created, readErr := os.ReadFile(filepath.Join(freshDir, "config.yaml"))
				if readErr != nil {
					return violation("a fresh install did not create config.yaml: %v", readErr)
				}
				if !strings.Contains(string(created), "autoUpdate: true") {
					return notApplicable("the generated fresh config no longer carries autoUpdate: true, so this case cannot measure the inherited-key hazard")
				}
				reported, explicit := reportedAutoUpdate(result)
				if reported {
					return violation("a fresh install (config carries the inherited autoUpdate: true) reports enable_extensions_auto_update=true (explicit=%t)", explicit)
				}
				return okResult("reports false")
			},
		},
		{
			id:        "config.legacy-only",
			checklist: "legacy.only",
			invariant: "a legacy enableExtensionsAutoUpdate: false is migrated for reporting and still resolves to OFF",
			run: func() caseResult {
				if clean, why := environmentIsClean(); !clean {
					return notApplicable("%s", why)
				}
				result, err := resolveProductOptions(legacyDir)
				if err != nil {
					return violation("resolving a legacy-only config failed: %v", err)
				}
				reported, explicit := reportedAutoUpdate(result)
				if reported {
					return violation("legacy enableExtensionsAutoUpdate: false reports true (explicit=%t)", explicit)
				}
				migrated, readErr := os.ReadFile(filepath.Join(legacyDir, "config.yaml"))
				if readErr != nil {
					return violation("the migrated config is unreadable: %v", readErr)
				}
				if !strings.Contains(string(migrated), "extensions:") {
					return violation("the legacy key was not migrated to extensions.autoUpdate; the config is %q", string(migrated))
				}
				return okResult("migrated and reports false")
			},
		},
		{
			id:        "config.parseable-config-rewritten",
			checklist: "config.readonly",
			// WHAT THIS CAN AND CANNOT ASSERT (adjudicated 2026-10-25, ARCHITECTURE 34.2/34.4).
			//
			// The first version asserted that the bytes are unchanged. That cannot hold and should not: pinned
			// INSERTS ITS DEFAULTS AT STARTUP (hard rule 13 -- "startup behavior is compatibility behavior",
			// reproduce "config creation/key migration/default insertion"), its own fixtures record that
			// insertion, and a drop-in replacement that quietly stopped doing it would be "safer but different",
			// which breaks parity exactly as badly as "different and worse".
			//
			// What a user is actually entitled to, and what this case now measures:
			//   1. their own keys and any unknown section still survive,
			//   2. a SECOND boot changes nothing (idempotence), so the file cannot drift or be re-serialised
			//      differently on every start.
			//
			// WHY "no auto-update key in the file" IS NOT ASSERTED HERE: pinned's default insertion writes
			// upstream's own keys, including extensions.autoUpdate: true, and pruning them out of the merge was
			// TRIED and broke six pinned-derived fixtures (the migration bytes and, through the merged config,
			// the CORS headers the basic-auth fixtures compare). The protection a user actually gets is the
			// DECISION layer -- ARCHITECTURE 34.3, where the inherited key is reporting-only and the only input
			// is gotavern.autoUpdateExtensions -- and that is measured directly by
			// config.autoupdate-inherited-true, config.autoupdate-fresh-install and
			// extensions.gotavern-key-strict. Asserting it on the bytes here would be measuring the wrong layer
			// and would fail for a reason that is not a defect.
			invariant: "rule 13/27: pinned's default insertion is reproduced, but the user's keys and unknown sections survive it, and a second boot is byte-identical",
			run: func() caseResult {
				if _, err := configinit.Initialize(rewritePath); err != nil {
					return violation("initializing a parseable config failed: %v", err)
				}
				after, err := os.ReadFile(rewritePath)
				if err != nil {
					return violation("the config is unreadable after boot: %v", err)
				}
				for _, kept := range []string{"port:", "someFutureSection:", "keptValue:"} {
					if !strings.Contains(string(after), kept) {
						return violation("boot lost the user's own configuration (%q is gone):\n%s", kept, after)
					}
				}
				if _, err := configinit.Initialize(rewritePath); err != nil {
					return violation("the second initialization failed: %v", err)
				}
				second, err := os.ReadFile(rewritePath)
				if err != nil {
					return violation("the config is unreadable after the second boot: %v", err)
				}
				if string(second) != string(after) {
					return violation("a second boot rewrote an up-to-date config (%d bytes -> %d bytes), so the file drifts on every start", len(after), len(second))
				}
				return okResult("pinned defaults inserted, user keys and unknown section kept, second boot byte-identical")
			},
		},
		{
			id:        "config.readonly-directory",
			checklist: "config.readonly",
			invariant: "a config in a read-only directory fails with a named error and leaves the bytes intact, rather than hanging or truncating (rule 12/35)",
			run: func() caseResult {
				if err := os.Chmod(readOnlyDir, 0o555); err != nil {
					return violation("chmod the config directory: %v", err)
				}
				defer func() { _ = os.Chmod(readOnlyDir, 0o755) }()
				if probeErr := os.WriteFile(filepath.Join(readOnlyDir, ".write-probe"), []byte("probe"), 0o644); probeErr == nil {
					_ = os.Remove(filepath.Join(readOnlyDir, ".write-probe"))
					return notApplicable("the read-only directory is still writable for this process, so the case cannot discriminate")
				}
				_, err := configinit.Initialize(readOnlyPath)
				after, readErr := os.ReadFile(readOnlyPath)
				if readErr != nil {
					return violation("the config became unreadable: %v", readErr)
				}
				if err == nil {
					return violation("a config in a read-only directory was rewritten without error")
				}
				if string(after) != readOnlyBody {
					return violation("the config was truncated by the failed write (%q -> %q)", readOnlyBody, string(after))
				}
				return okResult("refused with %v and the bytes are unchanged", err)
			},
		},
		{
			id:        "config.parent-directory-missing",
			checklist: "config.parent-missing",
			invariant: "a --configPath whose parent does not exist either creates the path or fails with a named error; it may not hang, panic or boot with a silently different config",
			run: func() caseResult {
				if clean, why := environmentIsClean(); !clean {
					return notApplicable("%s", why)
				}
				result, err := resolveProductOptions(missingParentDir, "--configPath", missingParentConfig)
				if err == nil {
					if _, statErr := os.Stat(missingParentConfig); statErr != nil {
						return violation("boot succeeded but %s does not exist: the resolved config must be readable at the requested path", missingParentConfig)
					}
					return okResult("created %s", result.Paths.ConfigFile)
				}
				if !strings.Contains(err.Error(), "config") && !strings.Contains(err.Error(), "absent") {
					return violation("the failure does not name the config path: %v", err)
				}
				return okResult("refused with %v", err)
			},
		},
		{
			id:        "lock.stale-file-does-not-block",
			checklist: "lock.stale",
			invariant: "a lock FILE left behind by a finished process does not block the next boot: only a held lock may wait (rule 24)",
			run: func() caseResult {
				started := time.Now()
				if _, err := configinit.Initialize(staleLockPath); err != nil {
					return violation("the first Initialize failed: %v", err)
				}
				key, err := canonicalLockKey(staleLockPath)
				if err != nil {
					return violation("canonicalise the config path: %v", err)
				}
				lockPath := productLockPath("gotavern-config-locks", key)
				if _, statErr := os.Stat(lockPath); statErr != nil {
					return violation("the product did not create %s, so this case cannot prove a leftover file is harmless: %v", lockPath, statErr)
				}
				if _, err := configinit.Initialize(staleLockPath); err != nil {
					return violation("the second Initialize with a leftover lock file failed: %v", err)
				}
				elapsed := time.Since(started)
				if elapsed > 5*time.Second {
					return violation("two Initialize calls with a leftover lock file took %s", elapsed.Round(10*time.Millisecond))
				}
				return okResult("leftover %s did not block (%s for both runs)", lockPath, elapsed.Round(time.Millisecond))
			},
		},
	}
}
