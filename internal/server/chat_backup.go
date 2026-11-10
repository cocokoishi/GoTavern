package server

// Pinned chat AUTO-BACKUP on /api/chats/save.
//
// PINNED SOURCE (read before changing anything here):
//
//	src/endpoints/chats.js:27-30   config read ONCE at module load (boot): enabled,
//	                               maxTotalBackups, throttleInterval, checkIntegrity
//	src/endpoints/chats.js:32      CHAT_BACKUPS_PREFIX = 'chat_'
//	src/endpoints/chats.js:42-49   getBackupKey: sanitize-filename, non-alnum -> '_',
//	                               lowercased, plus '_<sha256(raw UTF-8)[:8]>' when the
//	                               raw name has any code unit outside 0x20-0x7E
//	src/endpoints/chats.js:59-78   backupChat: <backups>/chat_<key>_<timestamp>.jsonl,
//	                               atomic write, per-chat prune (common.numberOfBackups),
//	                               then the global prune only when maxTotalBackups >= 0
//	src/endpoints/chats.js:83-99   getBackupFunction: one lodash.throttle per
//	                               `${handle} ${name}`, leading + trailing
//	src/endpoints/chats.js:118-122 process 'exit' flushes every trailing edge
//	src/endpoints/chats.js:532-543 trySaveChat: serialize, write, then schedule the backup
//	src/endpoints/chats.js:545-570 /save passes handle, cardName and
//	                               request.user.directories.backups
//	src/util.js:638-648            generateTimestamp: local YYYYMMDD-HHmmss
//	src/util.js:656-673            removeOldBackups: prefix filter, mtime ascending,
//	                               unlink while count > limit
//	src/util.js:1514-1521          tryWriteFileSync: mkdir -p, atomic replace
//	src/util.js:88-109             getConfigValue: env (`SILLYTAVERN_` + upper + '.'->'_')
//	                               wins over config, then the default; 'number' is
//	                               parseFloat with the default on NaN; 'boolean' is
//	                               toBoolean
//	src/util.js:38                 keyToEnv
//	default/config.yaml            backups.chat.enabled=true, maxTotalBackups=-1,
//	                               throttleInterval=10000, checkIntegrity=true,
//	                               backups.common.numberOfBackups=50
//	src/node_modules/lodash/throttle.js + debounce.js (wait, maxWait=wait,
//	                               leading+trailing; per-key state in a closure)
//
// OBSERVABLE CONTRACT reproduced here:
//   - the first save in a window writes a backup immediately (leading edge);
//   - further saves inside `throttleInterval` collapse to ONE trailing backup that
//     carries the LATEST bytes, written when the window closes;
//   - the key is `${handle} ${cardName}`, so different chats and different users are
//     independent;
//   - the backup body is exactly the bytes written to the chat file (same joined
//     string, no trailing newline);
//   - every backup filename is `<backups>/chat_<key>_<YYYYMMDD-HHmmss>.jsonl` in
//     local time;
//   - retention is per-chat first, then (only when maxTotalBackups >= 0) global over
//     the shared `chat_` prefix; files outside the prefix are never touched;
//   - a failed backup never changes the save response and never leaves a partial
//     file (the write goes through the product's atomic writer);
//   - a graceful shutdown flushes pending trailing edges exactly once, like pinned's
//     process 'exit' handler.
//
// DELIBERATE BOUNDARY (in the same change, as the product contract requires): the
// pinned config values are read ONCE per handler construction, i.e. at boot. A
// config.yaml/env change needs a restart, exactly as pinned's module-load reads do.
// The manager is in-memory only; a restart keeps the existing backup files on disk
// and starts with no throttle state, which is also pinned's behaviour.

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/cocokoishi/gotavern/internal/startup"
	"gopkg.in/yaml.v3"
)

const (
	chatBackupDefaultThrottleIntervalMilliseconds = float64(10_000)
	chatBackupDefaultMaxTotalBackups              = float64(-1)
	chatBackupDefaultNumberOfBackups              = float64(50)
	// chatBackupTimestampLayout is generateTimestamp's output: local YYYYMMDD-HHmmss.
	chatBackupTimestampLayout = "20060102-150405"
)

// chatBackupSettings is the pinned module-load snapshot of the four config values.
type chatBackupSettings struct {
	enabled          bool
	maxTotalBackups  float64
	throttleInterval time.Duration
	numberOfBackups  float64
	checkIntegrity   bool
}

// chatBackupJob is one throttled invocation: the latest (directory, name, data) the
// pinned throttle would call backupChat with.
type chatBackupJob struct {
	directory string
	cardName  string
	data      string
}

// chatBackupClock is the time seam for the throttle. Production uses the wall clock;
// tests drive a fake clock so leading/trailing edges are deterministic and no test
// sleeps out a real interval.
type chatBackupClock interface {
	Now() time.Time
	AfterFunc(duration time.Duration, function func()) chatBackupTimer
}

type chatBackupTimer interface {
	Stop() bool
}

type wallChatBackupClock struct{}

func (wallChatBackupClock) Now() time.Time { return time.Now() }

func (wallChatBackupClock) AfterFunc(duration time.Duration, function func()) chatBackupTimer {
	return time.AfterFunc(duration, function)
}

// chatBackupEntry is one lodash throttle closure: the state is per
// `${handle} ${cardName}` key.
type chatBackupEntry struct {
	invoked    bool
	lastInvoke time.Time
	pending    *chatBackupJob
	timer      chatBackupTimer
	// token invalidates a timer callback that was stopped, replaced or already fired.
	// A stale callback that was already running when Stop() missed it sees the token
	// mismatch and does nothing.
	token uint64
}

// chatBackupManager reproduces the pinned backupFunctions Map plus its throttle
// state. The mutex also serialises the backup writes, so two concurrent saves can
// not interleave a write with the same-second file name or with a retention pass.
type chatBackupManager struct {
	settings chatBackupSettings
	clock    chatBackupClock

	mu      sync.Mutex
	entries map[string]*chatBackupEntry
}

// chatBackupManagers is the set of live managers in this process. It exists solely
// so the graceful shutdown path can flush pending trailing edges the way pinned's
// process 'exit' handler does (src/endpoints/chats.js:118-122). Production creates
// exactly one manager per handler construction.
var chatBackupManagers sync.Map

// backups is the one chat-backup manager for this handler. Pinned reads the four
// backups.chat.* values once at module load, so the manager (and its config
// snapshot) is created at handler construction and shared by the 1:1 and group save
// routes. A zero accountRuntime, which tests construct directly, gets a default
// manager on first use rather than a nil dereference.
func (runtime *accountRuntime) backups() *chatBackupManager {
	if runtime.backupManager == nil {
		runtime.backupManager = newChatBackupManager(chatBackupSettingsForOptions(runtime.options))
	}
	return runtime.backupManager
}
func newChatBackupManager(settings chatBackupSettings) *chatBackupManager {
	manager := &chatBackupManager{
		settings: settings,
		clock:    wallChatBackupClock{},
		entries:  make(map[string]*chatBackupEntry),
	}
	chatBackupManagers.Store(manager, struct{}{})
	return manager
}

// FlushChatBackups writes every pending trailing backup exactly once. It is the
// explicit, test-callable equivalent of pinned's process exit flush and is called by
// the server shutdown path after requests have drained. A second call is a no-op
// because each pending job is cleared before it is written.
func FlushChatBackups() {
	chatBackupManagers.Range(func(key, _ any) bool {
		if manager, ok := key.(*chatBackupManager); ok {
			manager.flush()
		}
		return true
	})
}

// record mirrors `getBackupFunction(handle, cardName)(directory, cardName, data)`.
// The leading edge is synchronous, exactly as lodash's throttle invokes the function
// on the first call in a window, so the save response is sent after the leading
// backup attempt has completed. A backup error is swallowed: it can never change the
// HTTP response.
func (manager *chatBackupManager) record(handle, cardName, directory, data string) {
	if !manager.settings.enabled {
		return
	}
	key := handle + " " + cardName
	job := chatBackupJob{directory: directory, cardName: cardName, data: data}

	manager.mu.Lock()
	defer manager.mu.Unlock()

	entry, exists := manager.entries[key]
	if !exists {
		entry = &chatBackupEntry{}
		manager.entries[key] = entry
	}
	now := manager.clock.Now()
	// lodash debounce's shouldInvoke reduces to this for throttle(maxWait=wait):
	// the first call, or one that arrives at/after the window opened by the last
	// actual invocation. That invocation is the leading edge (timerId undefined) or
	// the maxWait branch (a timer is still armed); both invoke immediately with the
	// CURRENT arguments and re-arm the timer for `wait`.
	if !entry.invoked || !now.Before(entry.lastInvoke.Add(manager.settings.throttleInterval)) {
		if entry.timer != nil {
			entry.timer.Stop()
			entry.timer = nil
		}
		entry.pending = nil
		entry.invoked = true
		entry.lastInvoke = now
		manager.armTimerLocked(entry, key, manager.settings.throttleInterval)
		manager.performLocked(job)
		return
	}
	// Inside the window: remember only the latest data. lodash's trailingEdge
	// invokes with the last arguments it saw.
	entry.pending = &job
	if entry.timer == nil {
		// A previous trailing edge has fired, so the next trailing edge is measured
		// from this call (debounce's `if (timerId === undefined) setTimeout(wait)`).
		manager.armTimerLocked(entry, key, manager.settings.throttleInterval)
	}
}

func (manager *chatBackupManager) armTimerLocked(entry *chatBackupEntry, key string, wait time.Duration) {
	entry.token++
	token := entry.token
	entry.timer = manager.clock.AfterFunc(wait, func() {
		manager.fire(key, token)
	})
}

// fire is lodash's timerExpired -> trailingEdge for one key.
func (manager *chatBackupManager) fire(key string, token uint64) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	entry, exists := manager.entries[key]
	if !exists || entry.token != token {
		return
	}
	entry.timer = nil
	if entry.pending == nil {
		return
	}
	job := *entry.pending
	entry.pending = nil
	entry.invoked = true
	entry.lastInvoke = manager.clock.Now()
	manager.performLocked(job)
}

// flush is lodash's `flush()` for every key: only the trailing edge can be pending.
func (manager *chatBackupManager) flush() {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	for _, entry := range manager.entries {
		if entry.timer != nil {
			entry.timer.Stop()
			entry.timer = nil
		}
		entry.token++
		if entry.pending == nil {
			continue
		}
		job := *entry.pending
		entry.pending = nil
		entry.invoked = true
		entry.lastInvoke = manager.clock.Now()
		manager.performLocked(job)
	}
}

// performLocked is backupChat: every error is caught and logged upstream; here the
// error is deliberately discarded because the save response is already committed and
// data safety is the chat file, not the backup.
func (manager *chatBackupManager) performLocked(job chatBackupJob) {
	if !manager.settings.enabled {
		return
	}
	_ = writeChatBackup(job.directory, job.cardName, job.data, manager.settings, manager.clock.Now())
}

// writeChatBackup is src/endpoints/chats.js:59-78. The directory is created
// recursively (tryWriteFileSync), the body is replaced atomically, and the two
// retention passes run in pinned's order.
func writeChatBackup(directory, cardName, data string, settings chatBackupSettings, now time.Time) error {
	if err := os.MkdirAll(directory, 0o777); err != nil {
		return err
	}
	key := chatBackupKey(cardName)
	backupFile := filepath.Join(directory, backupsChatPrefix+key+"_"+now.Format(chatBackupTimestampLayout)+".jsonl")
	if err := startup.WriteFileAtomic(backupFile, []byte(data)); err != nil {
		return err
	}
	if err := removeOldChatBackups(directory, backupsChatPrefix+key+"_", settings.numberOfBackups); err != nil {
		return err
	}
	if math.IsNaN(settings.maxTotalBackups) || settings.maxTotalBackups < 0 {
		return nil
	}
	return removeOldChatBackups(directory, backupsChatPrefix, settings.maxTotalBackups)
}

// removeOldChatBackups is src/util.js:656-673: keep names that start with the prefix,
// sort by mtime ascending, unlink the oldest while the count exceeds the limit. The
// comparison is a float comparison on purpose: a fractional numberOfBackups of 2.5
// keeps 2 files, exactly like `files.length > 2.5`. Files outside the prefix are
// never candidates.
func removeOldChatBackups(directory, prefix string, limit float64) error {
	if math.IsNaN(limit) {
		return nil
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	type candidate struct {
		name    string
		modTime time.Time
	}
	candidates := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		// readdirSync lists directories too, but unlinkSync cannot remove one; a
		// non-file therefore is not a backup this pass may delete.
		if entry.IsDir() {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		candidates = append(candidates, candidate{name: name, modTime: info.ModTime()})
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		return candidates[left].modTime.Before(candidates[right].modTime)
	})
	remaining := float64(len(candidates))
	for _, item := range candidates {
		if !(remaining > limit) {
			break
		}
		if err := os.Remove(filepath.Join(directory, item.name)); err != nil {
			return err
		}
		remaining--
	}
	return nil
}

// chatBackupKey is src/endpoints/chats.js:42-49. The sanitize step reuses the
// product's pinned port of sanitize-filename 1.6.3 rather than growing a second copy
// of that contract.
//
// THE REPLACEMENT RUNS OVER UTF-16 CODE UNITS, NOT RUNES. `/.../g` in JavaScript
// matches one UTF-16 code unit at a time, so a non-BMP character (an emoji) becomes
// TWO underscores while a BMP CJK character becomes one. Iterating Go runes would
// silently give every astral character half its pinned underscore count, which is a
// different backup key and therefore a different file family.
func chatBackupKey(name string) string {
	sanitized := startup.SanitizeUserFilename(name)
	units := utf16.Encode([]rune(sanitized))
	var cleaned strings.Builder
	cleaned.Grow(len(units))
	for _, unit := range units {
		if (unit >= 'a' && unit <= 'z') ||
			(unit >= 'A' && unit <= 'Z') ||
			(unit >= '0' && unit <= '9') {
			cleaned.WriteByte(byte(unit))
			continue
		}
		cleaned.WriteByte('_')
	}
	key := strings.ToLower(cleaned.String())
	if chatBackupNameNeedsHash(name) {
		hash := sha256.Sum256([]byte(name))
		key += "_" + hex.EncodeToString(hash[:])[:8]
	}
	return key
}

// chatBackupNameNeedsHash is `/[^\x20-\x7E]/.test(name)` over the RAW name.
func chatBackupNameNeedsHash(name string) bool {
	for _, character := range name {
		if character < 0x20 || character > 0x7e {
			return true
		}
	}
	return false
}

// chatBackupEnvironmentName is util.js keyToEnv.
func chatBackupEnvironmentName(key string) string {
	return "SILLYTAVERN_" + strings.ToUpper(strings.ReplaceAll(key, ".", "_"))
}

var (
	chatBackupJSFloatPattern = regexp.MustCompile(`^[+-]?(Infinity|[0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?`)
	chatBackupJSSpace        = regexp.MustCompile(`^[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
)

// chatBackupNumber is `getConfigValue(key, fallback, 'number')` followed by
// `Number(...)`: JavaScript parseFloat, with the caller's default on NaN.
func chatBackupNumber(value any, fallback float64) float64 {
	if number, ok := chatBackupParseFloat(value); ok {
		return number
	}
	return fallback
}

// chatBackupParseFloat implements JavaScript parseFloat for the YAML/env value
// types this config can contain: it skips leading whitespace, then parses the
// longest valid numeric prefix (`"10000ms"` is 10000, `"abc"` is NaN).
func chatBackupParseFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) {
			return 0, false
		}
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case uint64:
		return float64(typed), true
	case string:
		text := chatBackupJSSpace.ReplaceAllString(typed, "")
		match := chatBackupJSFloatPattern.FindString(text)
		if match == "" {
			return 0, false
		}
		if strings.HasSuffix(match, "Infinity") {
			if strings.HasPrefix(match, "-") {
				return math.Inf(-1), true
			}
			return math.Inf(1), true
		}
		number, err := strconv.ParseFloat(match, 64)
		if err != nil {
			return 0, false
		}
		return number, true
	default:
		return 0, false
	}
}

// chatBackupThrottle converts milliseconds to a duration the way lodash's
// `toNumber(wait) || 0` does: a non-positive wait means "every call invokes
// immediately", because lodash's shouldInvoke compares against a wait <= 0 and is
// therefore always true. (A wait above the duration range is clamped; pinned's
// setTimeout overflows such a value into a 1ms re-arm loop, which has no file-level
// observable for a throttle whose shouldInvoke still uses the huge value.)
func chatBackupThrottle(milliseconds float64) time.Duration {
	if !(milliseconds > 0) {
		return 0
	}
	nanoseconds := milliseconds * float64(time.Millisecond)
	if nanoseconds >= float64(math.MaxInt64) {
		return time.Duration(math.MaxInt64)
	}
	return time.Duration(nanoseconds)
}

// chatBackupConfigCandidates lists the runtime config files in the order this boot
// would have resolved them: the command-line config path first (pinned's own file),
// then the install-root and data-root neighbours used by this package's other
// boot-time config readers.
func chatBackupConfigCandidates(options HTTPHandlerOptions) []string {
	candidates := make([]string, 0, 3)
	if options.ConfigPath != "" {
		candidates = append(candidates, options.ConfigPath)
	}
	if options.InstallRoot != "" {
		candidates = append(candidates, filepath.Join(options.InstallRoot, "config.yaml"))
	}
	if options.DataRoot != "" {
		candidates = append(candidates, filepath.Join(filepath.Dir(options.DataRoot), "config.yaml"))
	}
	return candidates
}

// chatBackupSettingsForOptions resolves the four pinned config reads ONCE, at
// handler construction, with getConfigValue's precedence: environment override, then
// the runtime config file, then the pinned default.
func chatBackupSettingsForOptions(options HTTPHandlerOptions) chatBackupSettings {
	config, loaded := readChatBackupConfig(options)
	value := func(key string, fallback any) any {
		if raw, exists := os.LookupEnv(chatBackupEnvironmentName(key)); exists {
			return raw
		}
		if loaded {
			if resolved, found := chatBackupDottedValue(config, key); found {
				return resolved
			}
		}
		return fallback
	}
	return chatBackupSettings{
		enabled:          pinnedToBoolean(value("backups.chat.enabled", true)),
		maxTotalBackups:  chatBackupNumber(value("backups.chat.maxTotalBackups", chatBackupDefaultMaxTotalBackups), chatBackupDefaultMaxTotalBackups),
		throttleInterval: chatBackupThrottle(chatBackupNumber(value("backups.chat.throttleInterval", chatBackupDefaultThrottleIntervalMilliseconds), chatBackupDefaultThrottleIntervalMilliseconds)),
		numberOfBackups:  chatBackupNumber(value("backups.common.numberOfBackups", chatBackupDefaultNumberOfBackups), chatBackupDefaultNumberOfBackups),
		checkIntegrity:   pinnedToBoolean(value("backups.chat.checkIntegrity", true)),
	}
}

func readChatBackupConfig(options HTTPHandlerOptions) (map[string]any, bool) {
	for _, candidate := range chatBackupConfigCandidates(options) {
		body, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		var parsed map[string]any
		if yaml.Unmarshal(body, &parsed) != nil || parsed == nil {
			continue
		}
		return parsed, true
	}
	return nil, false
}

// chatBackupDottedValue is lodash `_.get(config, key)`: an existing member with a
// null value is PRESENT (and therefore resolves to null, not to the default).
func chatBackupDottedValue(config map[string]any, key string) (any, bool) {
	var current any = config
	for _, part := range strings.Split(key, ".") {
		mapping, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = mapping[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}
