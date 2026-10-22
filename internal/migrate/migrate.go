// Package migrate implements `gotavern migrate`: copying an existing SillyTavern runtime into a
// GoTavern installation, as specified by docs/INSTALLATION.md section 6.
//
// THERE IS NO PINNED COUNTERPART. Pinned SillyTavern has no `migrate` subcommand, so nothing here is
// parity with pinned behaviour and nothing in this package or its tests claims to be: this is GoTavern
// PRODUCT behaviour defined by the documented contract. What is pinned instead is the contract's own
// consequences -- the source is never written, a migrated install is equivalent to one pointed at the
// source, --dry-run writes nothing, a second migration either reproduces the tree or refuses by name,
// plugins are reported and never copied, unknown config keys survive byte for byte, symlinks are
// refused loudly, and every documented form is parsed (see migrate_test.go, which labels each).
//
// THE ONE PROPERTY A MISTAKE HERE DESTROYS is that the source stays read-only. Every write in this
// package goes through destination paths resolved once in buildPlan, and the plan refuses outright when
// the destination and the source overlap in either direction.
package migrate

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"gopkg.in/yaml.v3"
)

// Refusal is a decision the migration makes on purpose: a missing or ambiguous source, a destination
// that already holds a runtime, symlinks in the source, an absolute-or-complex source data root. It is
// separate from an I/O failure so a caller (and a test) can tell "we said no" from "it broke".
type Refusal struct {
	Reason string
}

func (refusal Refusal) Error() string { return refusal.Reason }

func refuse(format string, args ...any) error {
	return Refusal{Reason: fmt.Sprintf(format, args...)}
}

// Options is the parsed command line.
type Options struct {
	// FromRoot is `--from`: a SillyTavern runtime/repository root containing config.yaml.
	FromRoot string
	// SourceConfig and SourceData are `--source-config` and `--source-data`, used together.
	SourceConfig string
	SourceData   string
	// SourceGlobal is `--source-global`: the pinned global data directory.
	SourceGlobal bool
	// Dest is `--dest`: the GoTavern runtime root to create or update.
	Dest   string
	DryRun bool
	Force  bool

	// GlobalDataDirectory overrides the pinned global data directory. It exists so a test can point
	// `--source-global` at a scratch tree; the command line never sets it.
	GlobalDataDirectory string
}

// DestinationLayout is the only layout this command writes. It is fixed rather than configurable
// because a migration that guessed where the runtime lives would be a way to write somewhere the user
// did not name.
const (
	DestConfigName    = "config.yaml"
	DestDataName      = "data"
	DestCertsName     = "certs"
	DestOverlayPath   = "public/scripts/extensions/third-party"
	DestBackupName    = ".migrate-backup"
	destDataRootValue = "./data"
)

// Plan is the complete, side-effect-free description of a migration.
type Plan struct {
	SourceRoot     string
	SourceConfig   string
	SourceData     string
	DestDir        string
	DestConfig     string
	DestData       string
	CopyCerts      bool
	CopyOverlay    bool
	Plugins        []string
	Conflicts      []string
	DataFiles      int
	DataBytes      int64
	OverlayFiles   int
	CertsFiles     int
	ConfigRewrites string
}

const usageText = `Usage:
  gotavern migrate --from <sillytavern-root> --dest <dir> [--dry-run] [--force]
  gotavern migrate --source-config <config.yaml> --source-data <dir> --dest <dir> [--dry-run] [--force]
  gotavern migrate --source-global --dest <dir> [--dry-run] [--force]

Copies a SillyTavern runtime into a GoTavern installation. The SOURCE IS NEVER MODIFIED.
The destination gets config.yaml (with only its dataRoot changed), data/, certs/ and the global
third-party extension overlay when the source has them. Node server plugins are REPORTED, not copied.
Symlinks in the source are refused. A destination that already holds a runtime is refused unless
--force is given, which moves the existing state to <dest>/.migrate-backup/ first.`

// ParseOptions parses the documented forms. A missing or ambiguous source is a named error, never a
// guess: exactly one of --from / (--source-config with --source-data) / --source-global.
func ParseOptions(args []string) (Options, error) {
	options := Options{}
	var haveConfig, haveData bool
	for index := 0; index < len(args); index++ {
		argument := args[index]
		takeValue := func(name string) (string, error) {
			if index+1 >= len(args) {
				return "", refuse("%s requires a value", name)
			}
			index++
			return args[index], nil
		}
		var err error
		switch argument {
		case "--from":
			options.FromRoot, err = takeValue(argument)
		case "--source-config":
			options.SourceConfig, err = takeValue(argument)
			haveConfig = true
		case "--source-data":
			options.SourceData, err = takeValue(argument)
			haveData = true
		case "--source-global":
			options.SourceGlobal = true
		case "--dest":
			options.Dest, err = takeValue(argument)
		case "--dry-run":
			options.DryRun = true
		case "--force":
			options.Force = true
		case "-h", "--help":
			return Options{}, refuse("%s", usageText)
		default:
			return Options{}, refuse("unknown argument: %s\n\n%s", argument, usageText)
		}
		if err != nil {
			return Options{}, err
		}
	}

	forms := 0
	if options.FromRoot != "" {
		forms++
	}
	if haveConfig || haveData {
		if !haveConfig || !haveData {
			return Options{}, refuse("--source-config and --source-data must be given together")
		}
		forms++
	}
	if options.SourceGlobal {
		forms++
	}
	switch {
	case forms == 0:
		return Options{}, refuse("no source given: use --from, --source-config with --source-data, or --source-global\n\n%s", usageText)
	case forms > 1:
		return Options{}, refuse("more than one source given: --from, the --source-config/--source-data pair and --source-global are alternatives")
	}
	if options.Dest == "" {
		return Options{}, refuse("--dest is required: this command never guesses an installation directory")
	}
	return options, nil
}

// Run plans the migration, reports it, and (unless --dry-run) executes it. The report is printed for
// both a dry run and a real run, so the dry run shows exactly the plan that would execute.
func Run(options Options, stdout io.Writer) error {
	plan, err := buildPlan(options)
	if err != nil {
		return err
	}
	writePlan(stdout, plan, options.DryRun)
	if options.DryRun {
		fmt.Fprintln(stdout, "dry run: nothing was written to the source or the destination")
		return nil
	}

	if len(plan.Conflicts) > 0 {
		if !options.Force {
			return refuse("the destination already contains %s; re-run with --force to move it to %s/%s first",
				strings.Join(plan.Conflicts, ", "), plan.DestDir, DestBackupName)
		}
		backup := filepath.Join(plan.DestDir, DestBackupName)
		if _, statErr := os.Lstat(backup); statErr == nil {
			return refuse("a previous migration backup already exists at %s; move it away before forcing another migration", backup)
		}
		if err := os.MkdirAll(backup, 0o755); err != nil {
			return fmt.Errorf("create the migration backup directory: %w", err)
		}
		for _, conflict := range plan.Conflicts {
			if err := os.Rename(filepath.Join(plan.DestDir, conflict), filepath.Join(backup, conflict)); err != nil {
				return fmt.Errorf("move the existing destination %s aside: %w", conflict, err)
			}
		}
		fmt.Fprintf(stdout, "moved the existing destination state to %s\n", backup)
	}

	if err := os.MkdirAll(plan.DestDir, 0o755); err != nil {
		return fmt.Errorf("create the destination directory: %w", err)
	}
	if err := copyConfig(plan); err != nil {
		return err
	}
	files, bytes, err := copyTree(plan.SourceData, plan.DestData)
	if err != nil {
		return fmt.Errorf("copy the data root: %w", err)
	}
	if plan.CopyCerts {
		if _, _, err := copyTree(filepath.Join(plan.SourceRoot, DestCertsName), filepath.Join(plan.DestDir, DestCertsName)); err != nil {
			return fmt.Errorf("copy certs: %w", err)
		}
	}
	if plan.CopyOverlay {
		if _, _, err := copyTree(filepath.Join(plan.SourceRoot, filepath.FromSlash(DestOverlayPath)), filepath.Join(plan.DestDir, filepath.FromSlash(DestOverlayPath))); err != nil {
			return fmt.Errorf("copy the global extension overlay: %w", err)
		}
	}
	fmt.Fprintf(stdout, "copied %d data file(s), %d byte(s)\n", files, bytes)
	// The transitional shell helper recorded this as the thing the Go command should do, and it did not:
	// a copy that reports success while one file is short is what a user discovers weeks later. Every
	// copied tree is re-read and hashed against its source before this command claims success.
	verified, verifyErr := verifyCopy(plan.SourceData, plan.DestData)
	if verifyErr != nil {
		return verifyErr
	}
	moreTrees := ""
	if plan.CopyCerts {
		count, err := verifyCopy(filepath.Join(plan.SourceRoot, DestCertsName), filepath.Join(plan.DestDir, DestCertsName))
		if err != nil {
			return err
		}
		verified += count
		moreTrees = " and certs"
	}
	if plan.CopyOverlay {
		count, err := verifyCopy(filepath.Join(plan.SourceRoot, filepath.FromSlash(DestOverlayPath)), filepath.Join(plan.DestDir, filepath.FromSlash(DestOverlayPath)))
		if err != nil {
			return err
		}
		verified += count
		moreTrees += " and the extension overlay"
	}
	fmt.Fprintf(stdout, "verified %d copied file(s) byte for byte against the source%s\n", verified, moreTrees)
	fmt.Fprintf(stdout, "migrated into %s\n", plan.DestDir)
	fmt.Fprintln(stdout, "the source was not modified; start GoTavern with its own config and verify before removing the source")
	return nil
}

// verifyCopy re-reads both sides and requires the same relative paths with the same size and SHA-256, so
// a short read, a skipped directory or an extra file is reported here rather than discovered later.
func verifyCopy(source, destination string) (int, error) {
	type digest struct {
		size int64
		hash string
	}
	collect := func(root string) (map[string]digest, error) {
		found := make(map[string]digest)
		err := filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			relative, err := filepath.Rel(root, current)
			if err != nil {
				return err
			}
			body, err := os.ReadFile(current)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(body)
			found[filepath.ToSlash(relative)] = digest{size: int64(len(body)), hash: hex.EncodeToString(sum[:])}
			return nil
		})
		return found, err
	}
	sourceDigests, err := collect(source)
	if err != nil {
		return 0, fmt.Errorf("verify the copy: %w", err)
	}
	destinationDigests, err := collect(destination)
	if err != nil {
		return 0, fmt.Errorf("verify the copy: %w", err)
	}
	for path, expected := range sourceDigests {
		copied, present := destinationDigests[path]
		if !present {
			return 0, fmt.Errorf("the copy is incomplete: %s was not migrated", path)
		}
		if copied.hash != expected.hash || copied.size != expected.size {
			return 0, fmt.Errorf("the copy differs from the source at %s (%d bytes/%s copied vs %d bytes/%s in the source)", path, copied.size, copied.hash, expected.size, expected.hash)
		}
	}
	for path := range destinationDigests {
		if _, present := sourceDigests[path]; !present {
			return 0, fmt.Errorf("the copy contains %s, which is not in the source", path)
		}
	}
	return len(sourceDigests), nil
}

// buildPlan performs every read-only preflight and refuses anything it cannot do safely. Nothing is
// written here, which is what makes --dry-run a true no-op.
func buildPlan(options Options) (Plan, error) {
	plan := Plan{}
	sourceConfig, sourceRoot, err := resolveSource(options)
	if err != nil {
		return Plan{}, err
	}
	plan.SourceConfig = sourceConfig
	plan.SourceRoot = sourceRoot

	configuredRoot, found, parseErr := sourceDataRoot(sourceConfig)
	if parseErr != nil {
		return Plan{}, parseErr
	}
	if options.SourceData != "" {
		plan.SourceData, err = filepath.Abs(options.SourceData)
		if err != nil {
			return Plan{}, fmt.Errorf("resolve --source-data: %w", err)
		}
	} else if found {
		if filepath.IsAbs(configuredRoot) {
			// An absolute or out-of-tree data root is valid input (section 6); it is copied into the
			// destination, and only the destination config copy is pointed at the copy.
			plan.SourceData = filepath.Clean(configuredRoot)
		} else {
			plan.SourceData = filepath.Join(sourceRoot, filepath.FromSlash(strings.TrimPrefix(filepath.ToSlash(configuredRoot), "./")))
		}
	} else {
		plan.SourceData = filepath.Join(sourceRoot, DestDataName)
	}
	insideSource, err := isWithin(plan.SourceData, sourceRoot)
	if err != nil {
		return Plan{}, err
	}
	if !insideSource && !filepath.IsAbs(configuredRoot) && options.SourceData == "" {
		return Plan{}, refuse("the source data root %s escapes %s; pass --source-data to name it explicitly", plan.SourceData, sourceRoot)
	}
	if info, statErr := os.Stat(plan.SourceData); statErr != nil || !info.IsDir() {
		return Plan{}, refuse("the source data root %s is not a directory", plan.SourceData)
	}

	plan.DestDir, err = filepath.Abs(options.Dest)
	if err != nil {
		return Plan{}, fmt.Errorf("resolve --dest: %w", err)
	}
	plan.DestConfig = filepath.Join(plan.DestDir, DestConfigName)
	plan.DestData = filepath.Join(plan.DestDir, DestDataName)

	// Recursive-copy protection in BOTH directions: a destination inside the source would write into
	// the tree this command promises not to touch, and a source inside the destination would be
	// copied into itself.
	for _, pair := range []struct{ inner, outer, why string }{
		{plan.DestDir, plan.SourceRoot, "the destination is inside the source"},
		{plan.DestDir, plan.SourceData, "the destination is inside the source data root"},
		{plan.SourceRoot, plan.DestDir, "the source is inside the destination"},
		{plan.SourceData, plan.DestDir, "the source data root is inside the destination"},
	} {
		contained, containErr := isWithin(pair.inner, pair.outer)
		if containErr != nil {
			return Plan{}, containErr
		}
		if contained {
			return Plan{}, refuse("%s (%s); a migration must copy into a directory outside the source", pair.why, pair.inner)
		}
	}

	// Symlinks are refused rather than followed or preserved: a preserved link would point back into
	// the source tree the user is about to delete, and following one silently copies data from outside
	// the tree the user pointed at. Naming them is the only safe behaviour.
	for _, tree := range []struct{ path, what string }{
		{plan.SourceData, "the source data root"},
		{filepath.Join(sourceRoot, DestCertsName), "the source certs directory"},
		{filepath.Join(sourceRoot, filepath.FromSlash(DestOverlayPath)), "the source extension overlay"},
	} {
		if _, statErr := os.Lstat(tree.path); statErr != nil {
			continue
		}
		links, linkErr := collectSymlinks(tree.path)
		if linkErr != nil {
			return Plan{}, linkErr
		}
		if len(links) > 0 {
			return Plan{}, refuse("%s contains symlinks, which are refused: %s (dereference them, or copy the target into place, before migrating)",
				tree.what, strings.Join(links, ", "))
		}
	}

	// Plugins are reported and never copied: hard rule 16 makes arbitrary Node server plugins the one
	// explicit exclusion, and copying them would imply support the product does not have.
	if entries, readErr := os.ReadDir(filepath.Join(sourceRoot, "plugins")); readErr == nil {
		for _, entry := range entries {
			plan.Plugins = append(plan.Plugins, entry.Name())
		}
		sort.Strings(plan.Plugins)
	}
	if info, statErr := os.Stat(filepath.Join(sourceRoot, DestCertsName)); statErr == nil && info.IsDir() {
		plan.CopyCerts = true
		plan.CertsFiles, _, err = measureTree(filepath.Join(sourceRoot, DestCertsName))
		if err != nil {
			return Plan{}, err
		}
	}
	if info, statErr := os.Stat(filepath.Join(sourceRoot, filepath.FromSlash(DestOverlayPath))); statErr == nil && info.IsDir() {
		plan.CopyOverlay = true
		plan.OverlayFiles, _, err = measureTree(filepath.Join(sourceRoot, filepath.FromSlash(DestOverlayPath)))
		if err != nil {
			return Plan{}, err
		}
	}
	plan.DataFiles, plan.DataBytes, err = measureTree(plan.SourceData)
	if err != nil {
		return Plan{}, err
	}

	for _, existing := range []string{DestConfigName, DestDataName} {
		if _, statErr := os.Lstat(filepath.Join(plan.DestDir, existing)); statErr == nil {
			plan.Conflicts = append(plan.Conflicts, existing)
		}
	}
	plan.ConfigRewrites = fmt.Sprintf("dataRoot %s -> %s", describeSourceDataRoot(configuredRoot, found), destDataRootValue)
	return plan, nil
}

// resolveSource applies the three documented forms.
func resolveSource(options Options) (configPath, root string, err error) {
	switch {
	case options.FromRoot != "":
		root, err = filepath.Abs(options.FromRoot)
		if err != nil {
			return "", "", fmt.Errorf("resolve --from: %w", err)
		}
		configPath = filepath.Join(root, DestConfigName)
		if info, statErr := os.Stat(root); statErr != nil || !info.IsDir() {
			return "", "", refuse("--from %s is not a directory", root)
		}
		if _, statErr := os.Stat(configPath); statErr != nil {
			return "", "", refuse("--from %s has no %s to migrate", root, DestConfigName)
		}
		return configPath, root, nil
	case options.SourceConfig != "":
		configPath, err = filepath.Abs(options.SourceConfig)
		if err != nil {
			return "", "", fmt.Errorf("resolve --source-config: %w", err)
		}
		if _, statErr := os.Stat(configPath); statErr != nil {
			return "", "", refuse("--source-config %s does not exist", configPath)
		}
		return configPath, filepath.Dir(configPath), nil
	case options.SourceGlobal:
		globalDirectory := options.GlobalDataDirectory
		if globalDirectory == "" {
			globalDirectory, err = commandline.DefaultGlobalDataDirectory()
			if err != nil {
				return "", "", fmt.Errorf("resolve the global data directory: %w", err)
			}
		}
		root, err = filepath.Abs(globalDirectory)
		if err != nil {
			return "", "", fmt.Errorf("resolve the global data directory: %w", err)
		}
		configPath = filepath.Join(root, DestConfigName)
		if _, statErr := os.Stat(configPath); statErr != nil {
			return "", "", refuse("--source-global found no %s in %s", DestConfigName, root)
		}
		return configPath, root, nil
	}
	return "", "", refuse("no source given")
}

// sourceDataRoot reads ONLY the simple top-level scalar, as the transitional helper does; a complex
// value is refused rather than guessed at. An absolute value is valid input and is returned as-is.
func sourceDataRoot(configPath string) (string, bool, error) {
	body, err := os.ReadFile(configPath)
	if err != nil {
		return "", false, fmt.Errorf("read the source config: %w", err)
	}
	var document map[string]any
	if err := yaml.Unmarshal(body, &document); err != nil {
		return "", false, refuse("the source config %s is not valid YAML: %v", configPath, err)
	}
	value, found := document["dataRoot"]
	if !found {
		return "", false, nil
	}
	root, ok := value.(string)
	if !ok {
		return "", false, refuse("the source config dataRoot is %T, not a simple scalar; pass --source-data to name the data root explicitly", value)
	}
	root = strings.TrimSpace(root)
	root = strings.Trim(root, "\"'")
	root = strings.TrimSpace(root)
	if root == "" {
		return "", false, refuse("the source config dataRoot is empty; pass --source-data to name the data root explicitly")
	}
	if strings.Contains(root, "..") {
		return "", false, refuse("the source config dataRoot %q contains a parent traversal; pass --source-data to name the data root explicitly", root)
	}
	return root, true, nil
}

func describeSourceDataRoot(configured string, found bool) string {
	if !found {
		return "(absent, pinned default ./data)"
	}
	return configured
}

// copyConfig copies the source config and changes ONLY the data root, by editing that one scalar in
// place. A parse-and-reserialize would rewrite quoting, ordering and comments, which is why this is a
// textual edit: everything the source said -- including keys GoTavern has never heard of -- survives
// byte for byte, which is hard rule 11 and is compared byte-wise in the tests.
func copyConfig(plan Plan) error {
	body, err := os.ReadFile(plan.SourceConfig)
	if err != nil {
		return fmt.Errorf("read the source config: %w", err)
	}
	rewritten, err := rewriteDataRoot(body, destDataRootValue)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(plan.DestConfig), 0o755); err != nil {
		return fmt.Errorf("create the destination directory: %w", err)
	}
	if err := os.WriteFile(plan.DestConfig, rewritten, 0o644); err != nil {
		return fmt.Errorf("write the destination config: %w", err)
	}
	return nil
}

// rewriteDataRoot replaces the value of the top-level `dataRoot` scalar and leaves every other byte
// alone, including the line's trailing comment and its line ending. If the key is absent it is
// appended, so the destination always points at the copied data root.
func rewriteDataRoot(config []byte, value string) ([]byte, error) {
	text := string(config)
	lines := strings.SplitAfter(text, "\n")
	seen := 0
	for index, line := range lines {
		content := strings.TrimSuffix(line, "\n")
		trimmed := strings.TrimSuffix(content, "\r")
		if !strings.HasPrefix(trimmed, "dataRoot:") {
			continue
		}
		seen++
		rest := strings.TrimPrefix(trimmed, "dataRoot:")
		comment := ""
		if cut := strings.Index(rest, " #"); cut >= 0 {
			comment = rest[cut:]
			rest = rest[:cut]
		}
		ending := "\n"
		if strings.HasSuffix(content, "\r") {
			ending = "\r\n"
			trimmed = strings.TrimSuffix(content, "\r")
		}
		_ = rest
		lines[index] = "dataRoot: " + value + comment + ending
	}
	if seen > 1 {
		return nil, refuse("the source config declares dataRoot %d times; refusing to guess which one the runtime uses", seen)
	}
	if seen == 0 {
		if !strings.HasSuffix(text, "\n") && text != "" {
			text += "\n"
		}
		text += "dataRoot: " + value + "\n"
		return []byte(text), nil
	}
	return []byte(strings.Join(lines, "")), nil
}

// copyTree copies a directory recursively, preserving file modes and creating directories, and refuses
// to follow a symlink it meets on the way (the preflight names them, but a link created between the
// two passes must not become a read of somewhere else).
func copyTree(source, destination string) (files int, bytes int64, err error) {
	info, statErr := os.Lstat(source)
	if statErr != nil {
		return 0, 0, statErr
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return 0, 0, refuse("%s is a symlink", source)
	}
	if !info.IsDir() {
		return 0, 0, fmt.Errorf("%s is not a directory", source)
	}
	walkErr := filepath.WalkDir(source, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		entryInfo, err := os.Lstat(current)
		if err != nil {
			return err
		}
		switch {
		case entryInfo.Mode()&os.ModeSymlink != 0:
			return refuse("%s is a symlink", current)
		case entryInfo.IsDir():
			return os.MkdirAll(target, entryInfo.Mode().Perm()|0o700)
		case entryInfo.Mode().IsRegular():
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			written, err := copyFile(current, target, entryInfo.Mode().Perm())
			if err != nil {
				return err
			}
			files++
			bytes += written
			return nil
		default:
			// A socket, device or pipe is not runtime state a migration can carry.
			return refuse("%s is neither a regular file nor a directory (%s)", current, entryInfo.Mode().Type())
		}
	})
	return files, bytes, walkErr
}

func copyFile(source, destination string, mode fs.FileMode) (int64, error) {
	in, err := os.Open(source)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return written, copyErr
	}
	return written, closeErr
}

// collectSymlinks names every symlink under root, relative to it, sorted.
func collectSymlinks(root string) ([]string, error) {
	links := make([]string, 0)
	err := filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink == 0 {
			return nil
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		links = append(links, filepath.ToSlash(relative))
		return nil
	})
	sort.Strings(links)
	return links, err
}

// measureTree counts what a copy would carry, for the plan report.
func measureTree(root string) (files int, bytes int64, err error) {
	walkErr := filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files++
		bytes += info.Size()
		return nil
	})
	return files, bytes, walkErr
}

// isWithin reports whether inner is outer or inside it, comparing resolved absolute paths.
func isWithin(inner, outer string) (bool, error) {
	innerPath, err := filepath.Abs(inner)
	if err != nil {
		return false, err
	}
	outerPath, err := filepath.Abs(outer)
	if err != nil {
		return false, err
	}
	relative, err := filepath.Rel(outerPath, innerPath)
	if err != nil {
		return false, nil
	}
	if relative == "." {
		return true, nil
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)), nil
}

// writePlan prints the report. The same text is printed for --dry-run and for a real run, so the dry
// run cannot show a different plan from the one that executes.
func writePlan(stdout io.Writer, plan Plan, dryRun bool) {
	fmt.Fprintln(stdout, "GoTavern migration")
	fmt.Fprintf(stdout, "  source config: %s\n", plan.SourceConfig)
	fmt.Fprintf(stdout, "  source data:   %s\n", plan.SourceData)
	fmt.Fprintf(stdout, "  destination:   %s\n", plan.DestDir)
	fmt.Fprintf(stdout, "  data:          %d file(s), %d byte(s)\n", plan.DataFiles, plan.DataBytes)
	fmt.Fprintf(stdout, "  config:        %s\n", plan.ConfigRewrites)
	if plan.CopyCerts {
		fmt.Fprintf(stdout, "  certs:         %d file(s)\n", plan.CertsFiles)
	} else {
		fmt.Fprintln(stdout, "  certs:         none in the source")
	}
	if plan.CopyOverlay {
		fmt.Fprintf(stdout, "  extensions:    global third-party overlay, %d file(s)\n", plan.OverlayFiles)
	} else {
		fmt.Fprintln(stdout, "  extensions:    no global overlay in the source")
	}
	if len(plan.Plugins) > 0 {
		fmt.Fprintf(stdout, "  server plugins (NOT migrated, unsupported): %s\n", strings.Join(plan.Plugins, ", "))
	} else {
		fmt.Fprintln(stdout, "  server plugins: none")
	}
	if len(plan.Conflicts) > 0 {
		fmt.Fprintf(stdout, "  destination conflicts: %s\n", strings.Join(plan.Conflicts, ", "))
	}
	if dryRun {
		fmt.Fprintln(stdout, "  mode:          dry run")
	}
}

// errors.Is plumbing for tests that only care whether a refusal happened.
func IsRefusal(err error) bool {
	var refusal Refusal
	return errors.As(err, &refusal)
}
