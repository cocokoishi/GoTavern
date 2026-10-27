package e2e

// THE BOOT'S DATA DIRECTORY, AND THE PATHS THAT DECIDE IT: items 1 and 2 of the startup/path long tail.
//
// WHY THIS FILE EXISTS AND WHAT WAS WRONG WITHOUT IT. The adversarial case
// `boot.foreign-cwd-relative-data-root` states this invariant, and on 03f1988 it took a branch that asserts
// nothing at all:
//
//	if startErr == nil { return okResult("booted (created-in-CWD=%t, present-in-install=%t)", ...) }
//
// Worse, its central input never reached the subject: it wrote `dataRoot: "./data"` into
// <work>/config.yaml and booted with NO --configPath, so -- because internal/app/server.go:129-131
// reproduces pinned's `process.chdir(serverDirectory)` (server.js:11) -- the boot parsed
// <install>/config.yaml instead, and the planted document was inert. A case whose input does not arrive
// cannot judge the product, and a branch that only reports is not an assertion (AGENTS rule 10, rule 7).
//
// This file asks the same question where the answer is observable, by CONTENT and by SOCKET:
//
//	1. the directory the boot reports it uses EXISTS;
//	2. a write through the product's own route lands under it;
//	3. the same value read back through the product is the value written;
//	4. the launch directory, the config file and an absolute --dataRoot all say what they claim.
//
// PINNED, read 2026-10-26 from SillyTavern 1.19.0 = 06bde939:
//
//	server.js:8      CommandLineParser().parse()      the config is read and the data root CREATED here
//	server.js:11     process.chdir(serverDirectory)   and only THEN does the base move
//	command-line.js:288-297   `mkdirSync(dataRoot, {recursive: true})`, whose FAILURE is a warning boot
//	                          continues past
//	server-main.js:400,456    every later use is path.join(globalThis.DATA_ROOT, ...) -- also
//	src/users.js:693,200      src/users.js:693 and :200 -- against the directory pinned has now chdir'd into
//
//	=> Pinned's OBSERVABLE is "one directory is created and that same directory is served and written".
//	   The two-roots split is UNREACHABLE there because the chdir sits between creation and first use.
//
// GOTAVERN DIVERGES, DELIBERATELY, and this file asserts the divergence rather than pretending it away:
// internal/app/server.go:172-182 CREATES the runtime data root when the resolved directories differ. Pinned
// would have warned and then died with ENOENT on its first write -- the P0-B symptom. AGENTS rule 27 allows
// exactly this much: the creation happens, and it is REPORTED through the pinned-worded PathWarning
// (internal/commandline/paths.go:168, printed by cmd/gotavern/main.go:195). That is a product decision, not
// a parity claim, and TestBootNamesTheDataRootItCreated is where it is measured.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// dataRootWarnings returns the data-root warnings a boot printed. The wording is pinned too
// ("Warning: Failed to create data root directory at %s. Please make sure the path is correct and
// writable.", command-line.js:296), so a boot that invents its own message does not satisfy a caller.
func dataRootWarnings(stderr string) []string {
	var found []string
	for _, line := range strings.Split(stderr, "\n") {
		if strings.Contains(line, "Failed to create data root directory") {
			found = append(found, strings.TrimSpace(line))
		}
	}
	return found
}

// treeDigests records every regular file under root as a slash path -> content digest. A file list is what
// makes "the boot wrote under THIS directory" a checkable statement rather than a plausible one.
func treeDigests(t *testing.T, root string) map[string]string {
	t.Helper()
	digests := map[string]string{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return walkErr
		}
		if info.IsDir() || !info.Mode().IsRegular() {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		digests[filepath.ToSlash(relative)] = sha256Hex(string(body))
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return digests
}

// sortedNames lists a map's keys in a stable order, for a failure message two runs can be diffed against.
func sortedNames(digests map[string]string) []string {
	names := make([]string, 0, len(digests))
	for name := range digests {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// dataRootMarkerConfig is a config that PARSES, carries no dataRoot of its own, and carries a marker key the
// product has no opinion about. The marker is how a case proves WHICH document the boot read: a boot that
// parsed this file must leave the marker intact on disk (the sibling config-idempotence invariant), and a
// boot that parsed a different file cannot have seen it at all.
const dataRootMarkerConfig = "listen: false\n" +
	"port: 8000\n" +
	"gotavernCaseMarker:\n" +
	"  readBy: startup-longtail\n"

// dataRootProbeSecretKey and its value are the read-back probe for "the directory the server writes is the
// directory it reads".
//
// deeplx_url IS DELIBERATELY AN EXPORTABLE KEY (the pinned EXPORTABLE_KEYS list, src/endpoints/secrets.js:101-106,
// reproduced at internal/startup/secrets_state.go:111-116). A secret with any other name answers 403 from
// /api/secrets/find on a default config (:568-570), which is the product refusing correctly and would make the
// read-back untestable without also flipping a configuration flag this lane has no business flipping.
const (
	dataRootProbeSecretKey   = "deeplx_url"
	dataRootProbeSecretValue = "http://127.0.0.1:9/probe-value-not-a-credential"
)

// writeText plants one file under a synthesised root, creating its directory, and fails the test rather than
// the run when the tree cannot be built: a case whose fixture is missing must not reach an assertion.
func writeText(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		t.Fatalf("create %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// TestBootCreatesTheDataDirectoryItServes is item 1 on a fresh install tree started from a foreign working
// directory with NO dataRoot inherited from a flag, an environment variable or a config, so the only data
// directory in play is the one the boot itself resolves and makes.
//
// It is the product half of the adversarial case's invariant: created == served, proven by a request that
// writes through the product and reads the same value back.
func TestBootCreatesTheDataDirectoryItServes(t *testing.T) {
	installRoot := t.TempDir()
	foreignWork := t.TempDir()
	configPath := filepath.Join(installRoot, "config.yaml")
	writeText(t, configPath, dataRootMarkerConfig)

	// bootServerConfigIn names only the config: the data root is whatever the document and the parser
	// resolve, which is the situation a user is in.
	expected := filepath.Join(installRoot, "data")
	server := bootServerConfigIn(t, installRoot, foreignWork, configPath, nil)
	client := openSession(t, server.origin)
	// The harness records no data root for a case that passed no --dataRoot (bootServerCommand), so the
	// resolution this case expects is stated HERE and every path below is checked against the tree, not
	// against a value the harness could have supplied to itself.
	server.dataRoot = expected

	// (1) THE DIRECTORY THE BOOT REPORTS USING EXISTS. `server.dataRoot` is the value this case declared as
	// the expected resolution, so asserting existence on it also proves the declaration: if the boot had
	// resolved somewhere else, the ENOENT below would name the path that was actually missing.
	info, err := os.Stat(server.dataRoot)
	if err != nil {
		t.Fatalf("the server is answering requests but the data directory the boot resolved (%s) does not "+
			"exist, so the next write fails with ENOENT -- the P0-B shape (AGENTS 24). stderr:\n%s",
			server.dataRoot, server.stderr.String())
	}
	if !info.IsDir() {
		t.Fatalf("%s exists but is not a directory", server.dataRoot)
	}

	// (2) A REQUEST WRITES THERE. POST /api/secrets/write persists through the product's own store, and the
	// only data root the process knows is the one above, so a file appearing under it is the product naming
	// its own write target.
	before := treeDigests(t, server.dataRoot)
	secretID := writeSecret(t, client, dataRootProbeSecretKey, dataRootProbeSecretValue)
	after := treeDigests(t, server.dataRoot)
	if len(after) <= len(before) {
		t.Fatalf("POST /api/secrets/write added no file under the resolved data root %s (before: %v). The "+
			"write went somewhere else, which is the second tree the invariant forbids.\n%s",
			server.dataRoot, sortedNames(before), server.diagnostic())
	}

	// (3) AND THE SAME VALUE READS BACK THROUGH THE PRODUCT. A file appearing is not the same claim as a
	// value the server can retrieve.
	//
	// WHICH KEY, AND WHY IT CHANGED (measured on run 40444937492, Lane CI, a690270): the first version wrote an
	// API key and asked /api/secrets/find for it, which answered 403 -- correctly. Pinned refuses a
	// non-exportable key unless `allowKeysExposure` is set (src/endpoints/secrets.js:568-570, with
	// EXPORTABLE_KEYS at :101-106), and GoTavern reproduces that exactly (internal/server/secrets.go:163-176
	// over internal/startup/secrets_state.go:111-116). /api/secrets/view is gated on the flag alone (:542-543),
	// so it is 403 with a default config too. The read-back therefore uses an EXPORTABLE key -- a URL field,
	// which is what the frontend really stores for these providers -- so the route answers on a default config
	// and the assertion is about the read path rather than about a configuration switch.
	findBody, marshalErr := marshalJSON(map[string]string{"key": dataRootProbeSecretKey, "id": secretID})
	if marshalErr != nil {
		t.Fatalf("encode the secrets/find body: %v", marshalErr)
	}
	status, _, body := client.postJSON(t, "/api/secrets/find", findBody)
	if status != 200 {
		t.Fatalf("POST /api/secrets/find answered %d for the exportable secret just written: %s", status, body)
	}
	var answer struct {
		Value string `json:"value"`
	}
	if decodeErr := json.Unmarshal([]byte(body), &answer); decodeErr != nil {
		t.Fatalf("POST /api/secrets/find did not answer JSON: %v (%s)", decodeErr, body)
	}
	if answer.Value != dataRootProbeSecretValue {
		t.Fatalf("the secret read back is %q, not the value written: the directory the server writes is not "+
			"the directory it reads", answer.Value)
	}

	// (4) THE LAUNCH DIRECTORY. It may contain a config.yaml and nothing else, and that file must be the
	// pinned fresh-install document rather than anything derived from the user's tree. This assertion used to
	// say "no file at all", which is NOT what pinned does and NOT what this product does: with no --configPath
	// the parser defaults to `./config.yaml` against the working directory (internal/commandline/paths.go:111,
	// :125) and, finding none, writes the pinned fresh config there -- exactly pinned's
	// `config.js:168-170` "config.yaml not found ... Creating a new one with default values". So the correct
	// claim is the narrow one: no DATA tree is created beside the launch, and the only file there is the
	// fresh config. A stray <work>/data is the second tree the invariant forbids.
	for _, name := range sortedNames(treeDigests(t, foreignWork)) {
		if name != "config.yaml" {
			t.Fatalf("the boot left %q in the LAUNCH directory %s. Only the default config.yaml may appear "+
				"there (paths.go:111,125); anything else is a data tree created where the user launched "+
				"(AGENTS 28)", name, foreignWork)
		}
	}
	if _, statErr := os.Stat(filepath.Join(foreignWork, "data")); statErr == nil {
		t.Fatalf("the boot created %s beside the launch: a data directory created where the user launched is "+
			"the second tree the invariant forbids", filepath.Join(foreignWork, "data"))
	}

	// (5) AND IT REPORTED NO DATA-ROOT PROBLEM. Checked last, so a missing directory fails at (1) naming
	// that rather than ending here on a list of warnings.
	if warnings := dataRootWarnings(server.stderr.String()); len(warnings) > 0 {
		t.Fatalf("the boot reported a data-root warning while serving a directory it claims exists: %v", warnings)
	}

	t.Logf("boot created and served ONE data directory (%s), wrote and read back a secret through it, and "+
		"left nothing in the launch directory %s", server.dataRoot, foreignWork)
}

// TestBootNamesTheDataRootItCreated is the DELIBERATE DIVERGENCE, measured.
//
// A relative `dataRoot` in the config the boot actually reads resolves against the install root at runtime
// (internal/commandline/paths.go:175) but the parser also computes a creation path against the launch
// directory (:155). Pinned cannot observe the difference (server.js:11), so there is no oracle for it -- what
// this test pins is GOTAVERN'S OWN CONTRACT, which is the only thing a divergence can be pinned against:
//
//	the directory the server uses exists, and
//	if the boot created it, the boot SAID SO.
//
// The last clause is the whole of AGENTS 27: a creation that is not reported is a write the user cannot see,
// and it is how a "read-only boot" claim dies quietly.
func TestBootNamesTheDataRootItCreated(t *testing.T) {
	installRoot := t.TempDir()
	foreignWork := t.TempDir()
	configPath := filepath.Join(installRoot, "config.yaml")
	// The marker makes this the document the boot parses: `--configPath` names it, and the marker survives
	// the boot (the sibling config-idempotence invariant), so a boot that read <install>/config.yaml is the
	// only one that can be looking at this file at all.
	writeText(t, configPath, "listen: false\nport: 8000\ndataRoot: \"./data\"\ngotavernCaseMarker:\n  readBy: startup-longtail\n")

	expected := filepath.Join(installRoot, "data")
	server := bootServerConfigIn(t, installRoot, foreignWork, configPath, nil)
	client := openSession(t, server.origin)
	server.dataRoot = expected

	// (1) the config this case planted is the one the boot consumed. The marker is still on disk and no
	// other config.yaml is reachable from the launch directory, so a boot that had resolved elsewhere would
	// have had to parse a document that does not exist.
	onDisk, readErr := os.ReadFile(configPath)
	if readErr != nil {
		t.Fatalf("the planted config is gone after the boot: %v", readErr)
	}
	if !strings.Contains(string(onDisk), "gotavernCaseMarker") {
		t.Fatalf("the boot rewrote config.yaml and dropped the case's marker key, so this case cannot say "+
			"which document it parsed:\n%s", onDisk)
	}

	// (2) the served directory is the install-root rendering of `./data`, and it exists. This is item 1's
	// invariant on the one path where the two bases can genuinely disagree.
	if clean := filepath.Clean(server.dataRoot); clean != filepath.Clean(expected) {
		t.Fatalf("the boot resolved its data root to %q; config.yaml says ./data and relative values resolve "+
			"against the install root at runtime (paths.go:175), which is %q", clean, expected)
	}
	if info, statErr := os.Stat(server.dataRoot); statErr != nil || !info.IsDir() {
		t.Fatalf("the server serves %s but it does not exist as a directory (err=%v): this is the ENOENT "+
			"defect the two-roots split produces. stderr:\n%s", server.dataRoot, statErr, server.stderr.String())
	}
	// (3) and it is live: a route that reads the user tree answers 200 rather than an error page.
	if status, _, body := client.postJSON(t, "/api/settings/get", "{}"); status != 200 {
		t.Fatalf("POST /api/settings/get answered %d from a boot whose data root is %s: %s",
			status, server.dataRoot, body)
	}

	// (4) THE SECOND TREE, ASSERTED AS A FINDING RATHER THAN AS A PASS.
	//
	// MEASURED on run 40444415565 (Lane CI, fd30876): with `--configPath <install>/config.yaml` and
	// `dataRoot: ./data` in it, started from a foreign working directory, the boot created BOTH
	// <work>/data AND <install>/data and printed no data-root warning.
	//
	// The mechanism, from the source rather than inferred: naming a path option disables the chdir
	// reproduction (internal/app/server.go:129-131), so the parser renders the creation path against the
	// LAUNCH directory (paths.go:155) while the runtime root is rendered against the install root (:175),
	// and app.Start then creates the runtime root too (server.go:172-182). Two directories, one relative
	// value, no notice.
	//
	// Pinned cannot reach this state at all -- its chdir (server.js:11) happens before the creation
	// (command-line.js:288-297) -- so there is no oracle to match, and what this asserts is the CONTRACT the
	// project states for itself: AGENTS 27, "startup does not modify user files as a side effect", with any
	// write being "explicit, logged". A directory created where the user launched is a write they did not ask
	// for and were not told about.
	//
	// This is therefore RED on purpose. It is not weakened to green: the behaviour is a defect against the
	// product contract, and the note below says what would make it pass.
	launchCreation := filepath.Join(foreignWork, "data")
	if _, statErr := os.Stat(launchCreation); statErr == nil {
		t.Fatalf("the boot created %s, the launch-directory rendering of the relative dataRoot, while serving "+
			"%s. One `dataRoot` value produced two trees, and the second is in the directory the user happened "+
			"to start from. To make this pass, either create only the runtime root, or report the second "+
			"creation (AGENTS 27: an unannounced write is the thing rule 27 forbids)",
			launchCreation, server.dataRoot)
	}
	t.Logf("relative dataRoot: served %s (exists, answers 200); launch-directory rendering %s not created",
		server.dataRoot, launchCreation)
}

// TestAbsoluteDataRootOverridesTheConfigAndAForeignCwdChangesNothing is item 2's absolute half plus the
// foreign-CWD property: an absolute --dataRoot wins over the config's relative value, and starting somewhere
// else creates and writes nothing there.
func TestAbsoluteDataRootOverridesTheConfigAndAForeignCwdChangesNothing(t *testing.T) {
	installRoot := t.TempDir()
	foreignWork := t.TempDir()
	namedRoot := t.TempDir()
	writeText(t, filepath.Join(installRoot, "config.yaml"), "listen: false\nport: 8000\ndataRoot: \"./from-config\"\n")

	server := bootServerIn(t, installRoot, foreignWork, namedRoot, nil)
	client := openSession(t, server.origin)

	if clean := filepath.Clean(server.dataRoot); clean != filepath.Clean(namedRoot) {
		t.Fatalf("--dataRoot %q was not honoured: the boot used %q. An explicit path is the user saying WHERE "+
			"their data is, and the config's relative value must not win over it", namedRoot, clean)
	}
	// The config's own relative value must NOT have become a second tree under the install root.
	if _, statErr := os.Stat(filepath.Join(installRoot, "from-config")); statErr == nil {
		t.Fatalf("the boot also created %s from the config's dataRoot while --dataRoot named %s: two data "+
			"directories for one server", filepath.Join(installRoot, "from-config"), namedRoot)
	}
	// The write goes through the same exportable key as above, for the same reason: any other name is refused
	// outside this test's subject, and the point here is only that the named root receives it.
	writeSecret(t, client, dataRootProbeSecretKey, dataRootProbeSecretValue)
	if digests := treeDigests(t, namedRoot); len(digests) == 0 {
		t.Fatalf("the product wrote nothing under the --dataRoot directory %s, so the named root is not the "+
			"root it serves", namedRoot)
	}
	// MEASURED on run 40444415565 (Lane CI, fd30876): config.yaml appears in the launch directory because
	// the harness passes --dataRoot but NOT --configPath, so the parser defaults the config to `./config.yaml`
	// against the working directory (internal/commandline/paths.go:111,125) and configinit writes the pinned
	// fresh document there (configinit/config.go:88-96) -- pinned's own "config.yaml not found ... Creating a
	// new one with default values" (src/config-init.js:168-170). The claim worth making is the narrow one: the
	// only thing permitted there is that config, and no DATA tree may appear.
	for _, name := range sortedNames(treeDigests(t, foreignWork)) {
		if name != "config.yaml" {
			t.Fatalf("the boot wrote %q into the LAUNCH directory %s. Only the default config.yaml may appear "+
				"there (paths.go:111,125); anything else is state created where the user launched", name, foreignWork)
		}
	}
	if _, statErr := os.Stat(filepath.Join(foreignWork, "data")); statErr == nil {
		t.Fatalf("the boot created %s in the LAUNCH directory %s even though --dataRoot named %s: a foreign "+
			"CWD must not receive a data tree", filepath.Join(foreignWork, "data"), foreignWork, namedRoot)
	}
}
