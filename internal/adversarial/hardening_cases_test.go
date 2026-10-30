package adversarial

// THE RELEASE-GATE ROWS NOTHING COVERED: a READ-ONLY CONFIG FILE, and MALFORMED USER DATA.
//
// The destructive-startup sweep has twelve rows. Ten of them already have an adversary or an app-level
// scenario, and those are cited by name in the report rather than re-implemented here (AGENTS.md: cite the
// existing coverage; do not build a second mechanism beside a working one). The rows below had NO case:
//
//   config.readonly-file     `config.readonly-directory` chmods the DIRECTORY, which Windows does not enforce
//                            for the process -- that case returns notApplicable on this host and therefore
//                            asserts nothing here. A read-only FILE is the shape Windows does enforce, and it is
//                            the shape a user actually creates ("chmod 444 config.yaml", "read-only" in
//                            Explorer), so the read-only row had no discriminating adversary on the host this
//                            lane runs on.
//
//   data.malformed           every malformed case in this package is about config.yaml (bad.yaml,
//                            truncated.yaml, autoupdate.*). Malformed USER DATA is a different path and a
//                            different hazard: boot PARSES node-persist records and the split secrets file, so a
//                            truncated file there can either abort a boot that should have warned (rule 35), or
//                            be silently rewritten by a "repair" (rule 27/28). Neither was measured.
//
// EACH CASE IS A NEGATIVE TEST with a bound (the runner provides it) and an assertion that can fail:
//   - truncation/emptiness is a violation, not a pass;
//   - a user's bytes changing is a violation;
//   - a failure that does not name the file is a violation.
//
// WHAT THE CASES DELIBERATELY DO NOT ASSERT, so a green is not over-read:
//   - whether booting over a read-only file is ACCEPTABLE (replacing it atomically on Linux vs failing on
//     Windows is a policy question, not a contract this suite can decide). The cases accept either outcome and
//     assert only what the contract makes unconditional: no truncation, no lost user keys, and a causal error
//     when it does fail.
//   - pinned's exact stderr line for either shape: the pinned server is not vendored here, so a byte claim
//     would be a derivation (AGENTS.md verification rule 4).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/configinit"
	"github.com/cocokoishi/gotavern/internal/startup"
)

func hardeningCases(t *testing.T) []caseSpec {
	t.Helper()

	readOnlyFileDir := t.TempDir()
	readOnlyFilePath := filepath.Join(readOnlyFileDir, "config.yaml")
	readOnlyFileBody := "listen: false\nport: 8000\nsomeFutureSection:\n  keptValue: 41\n"
	writeText(t, readOnlyFilePath, readOnlyFileBody)

	// MALFORMED SECRETS: a real tree first (so the layout is the product's, not this file's guess), then one
	// truncated JSON document at the split-secrets path.
	secretsInstall := t.TempDir()
	secretsData := t.TempDir()
	secretsWarmErr := func() error {
		_, err := startup.InitializeDataStartup(dataStartupOptions(secretsInstall, secretsData))
		return err
	}()
	secretsPath := filepath.Join(secretsData, "default-user", "secrets.json")
	const malformedSecrets = `{"api_key_openai": [`
	if secretsWarmErr == nil {
		writeText(t, secretsPath, malformedSecrets)
	}

	// MALFORMED NODE-PERSIST RECORD: the storage directory the product itself creates, one unparsable record.
	storageInstall := t.TempDir()
	storageData := t.TempDir()
	storageWarmErr := func() error {
		_, err := startup.InitializeDataStartup(dataStartupOptions(storageInstall, storageData))
		return err
	}()
	storageDir := filepath.Join(storageData, "_storage")
	const malformedRecord = "{\"key\":"
	if storageWarmErr == nil {
		if err := os.MkdirAll(storageDir, 0o777); err == nil {
			writeText(t, filepath.Join(storageDir, "a-malformed-record"), malformedRecord)
		}
	}

	return []caseSpec{
		{
			id:        "config.readonly-file",
			checklist: "config.readonly.file",
			invariant: "a READ-ONLY config file does not hang the boot, is never truncated or left unparsable, the user's own keys survive whatever the product does with the write, and a refusal names the config (rules 12/24/27/35)",
			run: func() caseResult {
				if err := os.Chmod(readOnlyFilePath, 0o444); err != nil {
					return violation("chmod the config file read-only: %v", err)
				}
				// Restore BEFORE the temporary directory is removed: on Windows a read-only file cannot be
				// deleted, so leaving the bit set would fail the cleanup and hide which case leaked it.
				defer func() { _ = os.Chmod(readOnlyFilePath, 0o644) }()

				// FAITHFULNESS: if this process can still write the file, the case cannot discriminate and must
				// say so rather than pass. (Windows enforces the attribute for files; POSIX does not, but there
				// the atomic-replace path is what has to be judged, which the assertions below still do.)
				writable := true
				if probeErr := os.WriteFile(readOnlyFilePath, []byte("probe"), 0o644); probeErr == nil {
					// Put the case's own body back: the probe must not become the input under test.
					writeText(t, readOnlyFilePath, readOnlyFileBody)
					_ = os.Chmod(readOnlyFilePath, 0o444)
				} else {
					writable = false
				}

				_, err := configinit.Initialize(readOnlyFilePath)
				after, readErr := os.ReadFile(readOnlyFilePath)
				if readErr != nil {
					return violation("the read-only config became unreadable after the boot: %v", readErr)
				}
				if len(after) == 0 {
					return violation("the read-only config was TRUNCATED to zero bytes (rule 12)")
				}
				for _, kept := range []string{"port:", "someFutureSection:", "keptValue:"} {
					if !strings.Contains(string(after), kept) {
						return violation("booting over a read-only config lost the user's own configuration (%q "+
							"is gone):\n%s", kept, after)
					}
				}
				if err != nil {
					lowered := strings.ToLower(err.Error())
					if !strings.Contains(lowered, "config") && !strings.Contains(lowered, "denied") &&
						!strings.Contains(lowered, "permission") {
						return violation("the boot refused the read-only config with an error that names neither "+
							"the config nor a permission cause: %v (rule 35: errors are causal)", err)
					}
					return okResult("refused with a causal error (%v), bytes intact and the user's keys present; "+
						"the read-only bit is enforced for this process: %t", err, !writable)
				}
				return okResult("completed with the user's keys intact; the read-only attribute was enforced for "+
					"this process: %t (a file replaced atomically is a policy question this case does not decide)",
					!writable)
			},
		},
		{
			id:        "boot.malformed-secrets",
			checklist: "data.malformed",
			invariant: "a truncated secrets.json must not be silently rewritten or DELETED by a boot that could not parse it, and the failure must be reported on the boot's own diagnostics naming the file (rules 12/27/28)",
			run: func() caseResult {
				if secretsWarmErr != nil {
					return notApplicable("the warm-up boot failed (%v), so the tree this case needs does not exist", secretsWarmErr)
				}
				if _, statErr := os.Stat(filepath.Dir(secretsPath)); statErr != nil {
					return notApplicable("the product created no user data root at %s, so this case cannot place its input", filepath.Dir(secretsPath))
				}
				_, err := startup.InitializeDataStartup(dataStartupOptions(secretsInstall, secretsData))
				after, readErr := os.ReadFile(secretsPath)
				if readErr != nil {
					return violation("the malformed secrets file was DELETED by the boot: %v (rule 28: a corrupt "+
						"user file is still the user's file)", readErr)
				}
				if string(after) != malformedSecrets {
					return violation("the boot REWROTE a secrets file it could not parse (%q -> %q): a repair "+
						"that discards a credential the user may still need is data loss, not recovery (rule 27)",
						malformedSecrets, string(after))
				}
				if err == nil {
					// Non-fatal on its own (the caller records a diagnostic), but it must BE reported.
					return reportDiagnostic(resultOf(secretsInstall, secretsData), "secrets")
				}
				if !strings.Contains(err.Error(), "secrets") {
					return violation("the boot refused the malformed secrets file with an error that does not name "+
						"it: %v", err)
				}
				return okResult("refused with a causal error naming secrets, bytes unchanged")
			},
		},
		{
			id:        "boot.malformed-user-storage",
			checklist: "data.malformed",
			invariant: "an unparsable node-persist record fails the boot with an error that NAMES the record file, and the user's record is left byte-identical (rules 12/24/28/35)",
			run: func() caseResult {
				if storageWarmErr != nil {
					return notApplicable("the warm-up boot failed (%v), so the storage directory this case needs does not exist", storageWarmErr)
				}
				recordPath := filepath.Join(storageDir, "a-malformed-record")
				if _, statErr := os.Stat(recordPath); statErr != nil {
					return notApplicable("the record planted by this case is not present (%v), so the input never arrived (rule 10)", statErr)
				}
				_, err := startup.InitializeDataStartup(dataStartupOptions(storageInstall, storageData))
				after, readErr := os.ReadFile(recordPath)
				if readErr != nil {
					return violation("the boot DELETED the unparsable node-persist record: %v (rule 28)", readErr)
				}
				if string(after) != malformedRecord {
					return violation("the boot REWROTE an unparsable node-persist record (%q -> %q)", malformedRecord, string(after))
				}
				if err == nil {
					return violation("an unparsable node-persist record was accepted silently: the user's stored " +
						"settings cannot be read and nothing said so")
				}
				if !strings.Contains(err.Error(), "node-persist record") {
					return violation("the boot failed without naming the record file: %v (rule 35)", err)
				}
				return okResult("refused with %v, record intact", err)
			},
		},
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// resultOf re-runs the data startup so a case can read the DIAGNOSTICS a non-fatal failure was recorded as. It
// is only called on the branch where the first run returned no error, so the second run measures the same
// input.
func resultOf(installRoot, dataRoot string) startup.DataStartupResult {
	result, _ := startup.InitializeDataStartup(dataStartupOptions(installRoot, dataRoot))
	return result
}

// reportDiagnostic decides a case whose data startup returned no error: the failure must appear on the
// diagnostics the caller is expected to print, naming the file.
func reportDiagnostic(result startup.DataStartupResult, needle string) caseResult {
	for _, diagnostic := range result.Diagnostics {
		if strings.Contains(errString(diagnostic.Err), needle) {
			return okResult("recorded as a %q diagnostic naming the file (%v); the bytes are unchanged",
				diagnostic.Stage, diagnostic.Err)
		}
	}
	return violation("the malformed %s file was neither migrated nor reported: the diagnostics carry %d "+
		"entr(ies) and none of them names it, so the user's broken credential file is silently ignored",
		needle, len(result.Diagnostics))
}
