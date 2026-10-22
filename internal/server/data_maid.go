package server

// Pinned source: SillyTavern 1.19.0 src/endpoints/data-maid.js — `/report` (:673), `/finalize`
// (:692), GET `/view` (:721), `/delete` (:770), and the DataMaidService collectors (:90-669).
//
// What this domain actually is, because the name invites the wrong reading: `/report` does NOT
// produce an archive. It returns `{report, token}` as JSON, where every record is a SANITIZED
// view of one loose file (basename, sha256 of the ABSOLUTE path, optional parent basename, size,
// mtimeMs) and the token is an in-memory handle over the UNSANITIZED absolute paths of the same
// report. `/view` fetches one of those files by hash, `/finalize` drops the token, `/delete`
// unlinks files listed by the token. There is no ZIP, no archive entry list and no download of
// the report itself; the archive-shaped comparison this repository applies to `/api/users/backup`
// has no counterpart here, so the entry-level comparison below is over the report's RECORDS plus
// the user tree's files (path, kind, size, sha256).
//
// Two values in a report can never be recorded as literals, and neither is "shape":
//
//   - the token is 32 random bytes, so the fixture references it ("the token minted by step N")
//     and asserts its CONSEQUENCES: what it unlocks, what an unknown token answers, that minting
//     for one handle does not invalidate another handle's token, and that finalize consumes it.
//   - each record's hash is sha256(ABSOLUTE path), which contains the host's data root. The
//     fixture records a marker keyed by the record's identity (category/parent/name) instead, and
//     the hash RULE is asserted separately as a labelled source-derived test.
//
// Everything else — status, headers, JSON structure, key presence, sizes, whole-second mtimes and
// the file bytes `/view` serves — is host-independent and is compared from the capture.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerDataMaidRoutes)
}

func registerDataMaidRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("POST /api/data-maid/report", accounts.serveDataMaidReport)
	mux.HandleFunc("POST /api/data-maid/finalize", accounts.serveDataMaidFinalize)
	mux.HandleFunc("GET /api/data-maid/view", accounts.serveDataMaidView)
	mux.HandleFunc("POST /api/data-maid/delete", accounts.serveDataMaidDelete)
}

// dataMaidChatBackupsPrefix is `CHAT_BACKUPS_PREFIX` (src/endpoints/chats.js:32).
const dataMaidChatBackupsPrefix = "chat_"

// dataMaidSettingsBackupPrefix is `getSettingsBackupFilePrefix(handle)` (src/endpoints/settings.js:88).
func dataMaidSettingsBackupPrefix(handle string) string {
	return "settings_" + handle + "_"
}

// dataMaidRecord is one sanitized record. The field order is the pinned object's literal order
// (`name`, `hash`, `parent`, `size`, `mtime`), because the response bytes are observable: the
// ETag of a report is a digest of them. `parent` is `void 0` for the collectors that pass
// `withParent = false`, which JSON.stringify omits, so it is a pointer here; `size` and `mtime`
// are `stat?.size` / `stat?.mtimeMs`, omitted only when the stat threw, so they are pointers too.
type dataMaidRecord struct {
	Name   string   `json:"name"`
	Hash   string   `json:"hash"`
	Parent *string  `json:"parent,omitempty"`
	Size   *int64   `json:"size,omitempty"`
	Mtime  *float64 `json:"mtime,omitempty"`
}

// dataMaidReport mirrors the pinned `sanitizedReport` object in its literal member order.
type dataMaidReport struct {
	Images               []dataMaidRecord `json:"images"`
	Files                []dataMaidRecord `json:"files"`
	Chats                []dataMaidRecord `json:"chats"`
	GroupChats           []dataMaidRecord `json:"groupChats"`
	AvatarThumbnails     []dataMaidRecord `json:"avatarThumbnails"`
	BackgroundThumbnails []dataMaidRecord `json:"backgroundThumbnails"`
	PersonaThumbnails    []dataMaidRecord `json:"personaThumbnails"`
	ChatBackups          []dataMaidRecord `json:"chatBackups"`
	SettingsBackups      []dataMaidRecord `json:"settingsBackups"`
}

type dataMaidReportResponse struct {
	Report dataMaidReport `json:"report"`
	Token  string         `json:"token"`
}

// dataMaidRawReport is the unsanitized report: absolute paths only, in the pinned member order,
// which is also the order the token's path list is built in.
type dataMaidRawReport struct {
	Images               []string
	Files                []string
	Chats                []string
	GroupChats           []string
	AvatarThumbnails     []string
	BackgroundThumbnails []string
	PersonaThumbnails    []string
	ChatBackups          []string
	SettingsBackups      []string
}

func (report dataMaidRawReport) categories() [][]string {
	return [][]string{
		report.Images,
		report.Files,
		report.Chats,
		report.GroupChats,
		report.AvatarThumbnails,
		report.BackgroundThumbnails,
		report.PersonaThumbnails,
		report.ChatBackups,
		report.SettingsBackups,
	}
}

type dataMaidStoredPath struct {
	path string
	hash string
}

type dataMaidTokenEntry struct {
	handle string
	paths  []dataMaidStoredPath
}

// dataMaidTokens is `DataMaidService.TOKENS`: process-wide in-memory state, replaced per handle
// on every `/report` and shared by every request handler, which is why it is package-level rather
// than per-runtime. Nothing persists it, so a restart forgets every token — pinned behaves the
// same way and the fixture pins the consequence (a token from a previous recording is unusable).
var dataMaidTokens = struct {
	sync.Mutex
	entries map[string]dataMaidTokenEntry
}{entries: make(map[string]dataMaidTokenEntry)}

func dataMaidPathHash(path string) string {
	digest := sha256.Sum256([]byte(path))
	return hex.EncodeToString(digest[:])
}

// mintDataMaidToken replaces any existing token for the handle, like DataMaidService.generateToken.
func mintDataMaidToken(handle string, raw dataMaidRawReport) (string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	token := hex.EncodeToString(random)
	paths := make([]dataMaidStoredPath, 0)
	for _, category := range raw.categories() {
		for _, path := range category {
			paths = append(paths, dataMaidStoredPath{path: path, hash: dataMaidPathHash(path)})
		}
	}
	dataMaidTokens.Lock()
	defer dataMaidTokens.Unlock()
	for existing, entry := range dataMaidTokens.entries {
		if entry.handle == handle {
			delete(dataMaidTokens.entries, existing)
		}
	}
	dataMaidTokens.entries[token] = dataMaidTokenEntry{handle: handle, paths: paths}
	return token, nil
}

func lookupDataMaidToken(token string) (dataMaidTokenEntry, bool) {
	dataMaidTokens.Lock()
	defer dataMaidTokens.Unlock()
	entry, exists := dataMaidTokens.entries[token]
	return entry, exists
}

func forgetDataMaidToken(token string) {
	dataMaidTokens.Lock()
	defer dataMaidTokens.Unlock()
	delete(dataMaidTokens.entries, token)
}

func (runtime *accountRuntime) serveDataMaidReport(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	raw := collectDataMaidReport(directories, account.string("handle"))
	report, err := sanitizeDataMaidReport(raw)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	token, err := mintDataMaidToken(account.string("handle"), raw)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, dataMaidReportResponse{Report: report, Token: token})
}

func (runtime *accountRuntime) serveDataMaidFinalize(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readAccountRequestBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	rawToken, exists := input["token"]
	if !exists || !nodeTruthyJSON(rawToken) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	value, err := decodeOrderedNodeJSON(rawToken)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	token, err := value.javascriptString()
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	entry, found := lookupDataMaidToken(token)
	if !found || entry.handle != account.string("handle") {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	forgetDataMaidToken(token)
	serveNoContent(w)
}

func (runtime *accountRuntime) serveDataMaidView(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	query := request.URL.Query()
	token, tokenPresent := firstOrJoinedQueryValue(query, "token")
	hash, hashPresent := firstOrJoinedQueryValue(query, "hash")
	if !tokenPresent || token == "" || !hashPresent || hash == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	entry, found := lookupDataMaidToken(token)
	if !found || entry.handle != account.string("handle") {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	var stored dataMaidStoredPath
	storedFound := false
	for _, candidate := range entry.paths {
		if candidate.hash == hash {
			stored = candidate
			storedFound = true
			break
		}
	}
	if !storedFound {
		serveStatusText(w, http.StatusNotFound)
		return
	}
	root := filepath.Join(runtime.options.DataRoot, account.string("handle"))
	if !nodePathIsUnderParent(root, stored.path) {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	if _, err := os.Stat(stored.path); err != nil {
		serveStatusText(w, http.StatusNotFound)
		return
	}
	content, err := os.ReadFile(stored.path)
	if err != nil {
		// A path that exists but cannot be read (a directory, a locked file) answers the pinned
		// 500: the route checks existence first and lets the read rejection reach its catch.
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	mediaType, known := pinnedUserAvatarMediaType(stored.path)
	if !known {
		mediaType = "text/plain"
	}
	w.Header().Set("Content-Type", mediaType)
	// The pinned compression middleware appends Accept-Encoding to Vary only for a type it would
	// compress, so a `text/plain` view carries "Origin, Accept-Encoding" while an `image/png` one
	// carries "Origin" alone. respondBinary cannot be used here for exactly that reason.
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.Header().Set("ETag", expressWeakETag(content))
	if !pinnedCompressibleContentType(mediaType) {
		w.Header().Set("Vary", "Origin")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func (runtime *accountRuntime) serveDataMaidDelete(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	input, valid := readAccountRequestBody(request)
	if !valid {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	rawToken, hasToken := input["token"]
	rawHashes, hasHashes := input["hashes"]
	var hashes []json.RawMessage
	if !hasToken || !nodeTruthyJSON(rawToken) || !hasHashes || json.Unmarshal(rawHashes, &hashes) != nil || len(hashes) == 0 {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	// The pinned handler keys the Map with `token` itself (no toString), so only a JSON string can
	// ever address a token; a number, array or object is a miss and answers 403.
	var token string
	tokenIsString := json.Unmarshal(rawToken, &token) == nil
	entry, found := dataMaidTokenEntry{}, false
	if tokenIsString {
		entry, found = lookupDataMaidToken(token)
	}
	if !found || entry.handle != account.string("handle") {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	root := filepath.Join(runtime.options.DataRoot, account.string("handle"))
	for _, rawHash := range hashes {
		var hash string
		if json.Unmarshal(rawHash, &hash) != nil {
			// `entry.hash === hash` is strict, so a non-string element never matches: skipped.
			continue
		}
		stored, storedFound := dataMaidStoredPath{}, false
		for _, candidate := range entry.paths {
			if candidate.hash == hash {
				stored = candidate
				storedFound = true
				break
			}
		}
		if !storedFound {
			continue
		}
		if !nodePathIsUnderParent(root, stored.path) {
			continue
		}
		if _, err := os.Stat(stored.path); err != nil {
			continue
		}
		if err := os.Remove(stored.path); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	serveNoContent(w)
}

// firstOrJoinedQueryValue mirrors Express's query object: a repeated key becomes an array, and the
// pinned handlers call `.toString()`, which joins the elements with ",". An absent key is
// `undefined` and falsy; an empty string is present but falsy, which the callers test separately.
func firstOrJoinedQueryValue(query map[string][]string, name string) (string, bool) {
	values, exists := query[name]
	if !exists || len(values) == 0 {
		return "", false
	}
	return strings.Join(values, ","), true
}

// nodePathIsUnderParent mirrors src/util.js `isPathUnderParent`: a sibling or an absolute result
// from path.relative is outside the parent. On Windows a path on another volume has no relative
// form at all, which Node reports as an absolute path.
func nodePathIsUnderParent(parentPath, childPath string) bool {
	parent := filepath.Clean(parentPath)
	child := filepath.Clean(childPath)
	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

// sanitizeDataMaidReport mirrors DataMaidService.sanitizeReport + #sanitizeRecord. A failed stat
// omits `size`/`mtime` (the pinned `stat?.size`), but a stat failure other than "does not exist"
// makes fs.promises.stat reject, which the route turns into 500.
func sanitizeDataMaidReport(raw dataMaidRawReport) (dataMaidReport, error) {
	report := dataMaidReport{
		Images:               make([]dataMaidRecord, 0, len(raw.Images)),
		Files:                make([]dataMaidRecord, 0, len(raw.Files)),
		Chats:                make([]dataMaidRecord, 0, len(raw.Chats)),
		GroupChats:           make([]dataMaidRecord, 0, len(raw.GroupChats)),
		AvatarThumbnails:     make([]dataMaidRecord, 0, len(raw.AvatarThumbnails)),
		BackgroundThumbnails: make([]dataMaidRecord, 0, len(raw.BackgroundThumbnails)),
		PersonaThumbnails:    make([]dataMaidRecord, 0, len(raw.PersonaThumbnails)),
		ChatBackups:          make([]dataMaidRecord, 0, len(raw.ChatBackups)),
		SettingsBackups:      make([]dataMaidRecord, 0, len(raw.SettingsBackups)),
	}
	categories := []struct {
		target    *[]dataMaidRecord
		paths     []string
		withParen bool
	}{
		{&report.Images, raw.Images, true},
		{&report.Files, raw.Files, false},
		{&report.Chats, raw.Chats, true},
		{&report.GroupChats, raw.GroupChats, false},
		{&report.AvatarThumbnails, raw.AvatarThumbnails, false},
		{&report.BackgroundThumbnails, raw.BackgroundThumbnails, false},
		{&report.PersonaThumbnails, raw.PersonaThumbnails, false},
		{&report.ChatBackups, raw.ChatBackups, false},
		{&report.SettingsBackups, raw.SettingsBackups, false},
	}
	for _, category := range categories {
		for _, path := range category.paths {
			record, err := sanitizeDataMaidRecord(path, category.withParen)
			if err != nil {
				return report, err
			}
			*category.target = append(*category.target, record)
		}
	}
	return report, nil
}

func sanitizeDataMaidRecord(path string, withParent bool) (dataMaidRecord, error) {
	record := dataMaidRecord{Name: filepath.Base(path), Hash: dataMaidPathHash(path)}
	if withParent {
		parent := filepath.Base(filepath.Dir(path))
		record.Parent = &parent
	}
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return record, nil
		}
		return record, err
	}
	size := info.Size()
	mtime := float64(info.ModTime().UnixNano()) / 1e6
	record.Size = &size
	record.Mtime = &mtime
	return record, nil
}

// ---- collectors (DataMaidService#collect*) ---------------------------------------------------

// dataMaidOpenDirectory lists a directory in the operating system's enumeration order, which is
// what fs.promises.readdir returns. os.ReadDir would sort the names instead, which the pinned
// handler never does: the record order in a report is enumeration order, so the fixture compares
// the arrays as sorted sets and this code must not invent an order of its own either.
func dataMaidOpenDirectory(directory string) ([]os.DirEntry, error) {
	handle, err := os.Open(directory)
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	return handle.ReadDir(-1)
}

func collectDataMaidReport(directories startup.UserDirectories, handle string) dataMaidRawReport {
	return dataMaidRawReport{
		Images:               collectDataMaidImages(directories),
		Files:                collectDataMaidFiles(directories),
		Chats:                collectDataMaidChats(directories),
		GroupChats:           collectDataMaidGroupChats(directories),
		AvatarThumbnails:     collectDataMaidLooseThumbnails(directories["thumbnailsAvatar"], directories["characters"]),
		BackgroundThumbnails: collectDataMaidLooseThumbnails(directories["thumbnailsBg"], directories["backgrounds"]),
		PersonaThumbnails:    collectDataMaidLooseThumbnails(directories["thumbnailsPersona"], directories["avatars"]),
		ChatBackups:          collectDataMaidPrefixedFiles(directories["backups"], dataMaidChatBackupsPrefix),
		SettingsBackups:      collectDataMaidPrefixedFiles(directories["backups"], dataMaidSettingsBackupPrefix(handle)),
	}
}

// collectDataMaidLooseThumbnails is the body the three thumbnail collectors share: a file in the
// thumbnail directory is loose unless a same-NAMED file exists in the directory it thumbnails.
// Comparison is by basename only, so a thumbnail of a renamed or deleted original is loose.
func collectDataMaidLooseThumbnails(thumbnailDirectory, sourceDirectory string) []string {
	result := make([]string, 0)
	known := make(map[string]struct{})
	sources, err := dataMaidOpenDirectory(sourceDirectory)
	if err != nil {
		return result
	}
	for _, entry := range sources {
		if entry.Type().IsRegular() {
			known[entry.Name()] = struct{}{}
		}
	}
	thumbnails, err := dataMaidOpenDirectory(thumbnailDirectory)
	if err != nil {
		return result
	}
	for _, entry := range thumbnails {
		if _, exists := known[entry.Name()]; entry.Type().IsRegular() && !exists {
			result = append(result, filepath.Join(thumbnailDirectory, entry.Name()))
		}
	}
	return result
}

func collectDataMaidPrefixedFiles(directory, prefix string) []string {
	result := make([]string, 0)
	entries, err := dataMaidOpenDirectory(directory)
	if err != nil {
		return result
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasPrefix(entry.Name(), prefix) {
			result = append(result, filepath.Join(directory, entry.Name()))
		}
	}
	return result
}

// collectDataMaidChats is #collectChats: a chat folder is loose when no `<folder>.png` character
// exists. `path.parse(name).ext === '.png'` is case-sensitive and `name.replace('.png',”)`
// removes only the first occurrence, both of which matter for a folder named e.g. `a.png.png`.
func collectDataMaidChats(directories startup.UserDirectories) []string {
	result := make([]string, 0)
	known := make(map[string]struct{})
	characters, err := dataMaidOpenDirectory(directories["characters"])
	if err != nil {
		return result
	}
	for _, entry := range characters {
		if entry.Type().IsRegular() && nodePathExt(entry.Name()) == ".png" {
			known[strings.Replace(entry.Name(), ".png", "", 1)] = struct{}{}
		}
	}
	chatDirectories, err := dataMaidOpenDirectory(directories["chats"])
	if err != nil {
		return result
	}
	for _, directory := range chatDirectories {
		if !directory.IsDir() {
			continue
		}
		if _, exists := known[directory.Name()]; exists {
			continue
		}
		folder := filepath.Join(directories["chats"], directory.Name())
		files, err := dataMaidOpenDirectory(folder)
		if err != nil {
			// A failed listing keeps whatever was already collected, like the pinned try/catch.
			return result
		}
		for _, file := range files {
			if file.Type().IsRegular() && nodePathExt(file.Name()) == ".jsonl" {
				result = append(result, filepath.Join(folder, file.Name()))
			}
		}
	}
	return result
}

// collectDataMaidGroupChats is #collectGroupChats: a group chat file is loose when no group
// definition names it as `chat_id` or lists it in `chats`.
func collectDataMaidGroupChats(directories startup.UserDirectories) []string {
	result := make([]string, 0)
	known := make(map[string]struct{})
	groups, err := dataMaidOpenDirectory(directories["groups"])
	if err != nil {
		return result
	}
	for _, entry := range groups {
		if !entry.Type().IsRegular() || nodePathExt(entry.Name()) != ".json" {
			continue
		}
		data, err := readNodeJSONFile(filepath.Join(directories["groups"], entry.Name()))
		if err != nil || data == nil {
			continue
		}
		if chatID, exists := nodeStringMember(data, "chat_id"); exists && chatID != "" {
			known[chatID] = struct{}{}
		}
		if chats, exists := data["chats"]; exists {
			if items, ok := chats.([]any); ok {
				for _, item := range items {
					if text, ok := item.(string); ok {
						known[text] = struct{}{}
					}
				}
			}
		}
	}
	groupChats, err := dataMaidOpenDirectory(directories["groupChats"])
	if err != nil {
		return result
	}
	for _, entry := range groupChats {
		if !entry.Type().IsRegular() || nodePathExt(entry.Name()) != ".jsonl" {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), nodePathExt(entry.Name()))
		if _, exists := known[name]; !exists {
			result = append(result, filepath.Join(directories["groupChats"], entry.Name()))
		}
	}
	return result
}

// collectDataMaidImages is #collectImages: an image in `user/images` (one subdirectory deep) is
// loose unless some chat message or chat metadata references it. A reference that cannot be
// turned into a path — a non-string, which JS `String.prototype.startsWith` throws on — aborts
// the collector and returns the (empty) result, which is the pinned outer try/catch behaviour.
func collectDataMaidImages(directories startup.UserDirectories) []string {
	result := make([]string, 0)
	messages := dataMaidParseAllChats(directories, func(message map[string]any) bool {
		extra, ok := dataMaidMapMember(message, "extra")
		if !ok {
			return false
		}
		if image, exists := extra["image"]; exists && dataMaidTruthy(image) {
			return true
		}
		if video, exists := extra["video"]; exists && dataMaidTruthy(video) {
			return true
		}
		if _, exists := extra["image_swipes"]; exists && dataMaidIsArray(extra["image_swipes"]) {
			return true
		}
		if _, exists := extra["media"]; exists && dataMaidIsArray(extra["media"]) {
			return true
		}
		return false
	})
	known := make([]any, 0)
	for _, message := range messages {
		extra, ok := dataMaidMapMember(message, "extra")
		if !ok {
			continue
		}
		if image, exists := extra["image"]; exists && dataMaidTruthy(image) {
			known = append(known, image)
		}
		if video, exists := extra["video"]; exists && dataMaidTruthy(video) {
			known = append(known, video)
		}
		if swipes, ok := extra["image_swipes"].([]any); ok {
			known = append(known, swipes...)
		}
		if media, ok := extra["media"].([]any); ok {
			for _, item := range media {
				if entry, ok := item.(map[string]any); ok {
					if url, exists := entry["url"]; exists && dataMaidTruthy(url) {
						known = append(known, url)
					}
				}
			}
		}
	}
	metadata := dataMaidParseAllMetadata(directories, func(metadata map[string]any) bool {
		backgrounds, ok := metadata["chat_backgrounds"].([]any)
		return ok && len(backgrounds) > 0
	})
	for _, entry := range metadata {
		if backgrounds, ok := entry["chat_backgrounds"].([]any); ok {
			for _, background := range backgrounds {
				if dataMaidTruthy(background) {
					known = append(known, background)
				}
			}
		}
	}
	knownPaths := make(map[string]struct{})
	for _, value := range known {
		reference, ok := value.(string)
		if !ok {
			return result
		}
		if false && (strings.HasPrefix(reference, "http") || strings.HasPrefix(reference, "data:")) {
			continue
		}
		knownPaths[filepath.Join(directories["root"], filepath.FromSlash(reference))] = struct{}{}
	}
	images, err := dataMaidOpenDirectory(directories["userImages"])
	if err != nil {
		return result
	}
	for _, entry := range images {
		entryPath := filepath.Join(directories["userImages"], entry.Name())
		if entry.Type().IsRegular() {
			if _, exists := knownPaths[entryPath]; !exists {
				result = append(result, entryPath)
			}
		}
		if entry.IsDir() {
			files, err := dataMaidOpenDirectory(entryPath)
			if err != nil {
				return result
			}
			for _, file := range files {
				filePath := filepath.Join(entryPath, file.Name())
				if file.Type().IsRegular() {
					if _, exists := knownPaths[filePath]; !exists {
						result = append(result, filePath)
					}
				}
			}
		}
	}
	return result
}

// collectDataMaidFiles is #collectFiles: a file in `user/files` is loose unless a chat message,
// chat metadata or `settings.json` (extension attachments) references it. Unlike images, the
// `http`/`data:` prefixes are NOT filtered here, which is a pinned asymmetry reproduced on
// purpose: a `data:` URL simply never resolves to a path inside the files directory.
func collectDataMaidFiles(directories startup.UserDirectories) []string {
	result := make([]string, 0)
	messages := dataMaidParseAllChats(directories, func(message map[string]any) bool {
		extra, ok := dataMaidMapMember(message, "extra")
		if !ok {
			return false
		}
		if file, ok := dataMaidMapMember(extra, "file"); ok {
			if url, exists := file["url"]; exists && dataMaidTruthy(url) {
				return true
			}
		}
		if files, ok := extra["files"].([]any); ok && len(files) > 0 {
			return true
		}
		return false
	})
	known := make([]any, 0)
	for _, message := range messages {
		extra, ok := dataMaidMapMember(message, "extra")
		if !ok {
			continue
		}
		if file, ok := dataMaidMapMember(extra, "file"); ok {
			if url, exists := file["url"]; exists && dataMaidTruthy(url) {
				known = append(known, url)
			}
		}
		if files, ok := extra["files"].([]any); ok {
			for _, item := range files {
				if entry, ok := item.(map[string]any); ok {
					if url, exists := entry["url"]; exists && dataMaidTruthy(url) {
						known = append(known, url)
					}
				}
			}
		}
	}
	metadata := dataMaidParseAllMetadata(directories, func(metadata map[string]any) bool {
		attachments, ok := metadata["attachments"].([]any)
		return ok && len(attachments) > 0
	})
	for _, entry := range metadata {
		if attachments, ok := entry["attachments"].([]any); ok {
			for _, item := range attachments {
				if attachment, ok := item.(map[string]any); ok {
					if url, exists := attachment["url"]; exists && dataMaidTruthy(url) {
						known = append(known, url)
					}
				}
			}
		}
	}
	settingsPath := filepath.Join(directories["root"], "settings.json")
	if _, err := os.Stat(settingsPath); err == nil {
		if settings, readErr := readNodeJSONFile(settingsPath); readErr == nil && settings != nil {
			if extensionSettings, ok := dataMaidMapMember(settings, "extension_settings"); ok {
				if attachments, ok := extensionSettings["attachments"].([]any); ok {
					for _, item := range attachments {
						if file, ok := item.(map[string]any); ok {
							if url, exists := file["url"]; exists && dataMaidTruthy(url) {
								known = append(known, url)
							}
						}
					}
				}
				if characterAttachments, exists := extensionSettings["character_attachments"]; exists {
					if grouped, ok := characterAttachments.(map[string]any); ok {
						for _, files := range grouped {
							items, ok := files.([]any)
							if !ok {
								continue
							}
							for _, item := range items {
								if file, ok := item.(map[string]any); ok {
									if url, exists := file["url"]; exists && dataMaidTruthy(url) {
										known = append(known, url)
									}
								}
							}
						}
					}
				}
			}
		}
	}
	knownPaths := make(map[string]struct{})
	for _, value := range known {
		reference, ok := value.(string)
		if !ok {
			return result
		}
		knownPaths[filepath.Join(directories["root"], filepath.FromSlash(reference))] = struct{}{}
	}
	files, err := dataMaidOpenDirectory(directories["files"])
	if err != nil {
		return result
	}
	for _, entry := range files {
		entryPath := filepath.Join(directories["files"], entry.Name())
		if entry.Type().IsRegular() {
			if _, exists := knownPaths[entryPath]; !exists {
				result = append(result, entryPath)
			}
		}
	}
	return result
}

// dataMaidParseAllChats is #parseAllChats: group chats first, then every character chat, each
// message kept only when filterFn accepts it. A failed listing or parse yields [] (or the
// messages collected so far is NOT the pinned behaviour here: the pinned catch returns an empty
// array and logs).
func dataMaidParseAllChats(directories startup.UserDirectories, filterFn func(map[string]any) bool) []map[string]any {
	allChats := make([]map[string]any, 0)
	groupChats, err := dataMaidOpenDirectory(directories["groupChats"])
	if err != nil {
		return nil
	}
	for _, entry := range groupChats {
		if !entry.Type().IsRegular() || nodePathExt(entry.Name()) != ".jsonl" {
			continue
		}
		for _, message := range dataMaidParseChatFile(filepath.Join(directories["groupChats"], entry.Name())) {
			if filterFn(message) {
				allChats = append(allChats, message)
			}
		}
	}
	chatDirectories, err := dataMaidOpenDirectory(directories["chats"])
	if err != nil {
		return nil
	}
	for _, directory := range chatDirectories {
		if !directory.IsDir() {
			continue
		}
		folder := filepath.Join(directories["chats"], directory.Name())
		files, err := dataMaidOpenDirectory(folder)
		if err != nil {
			return nil
		}
		for _, file := range files {
			if !file.Type().IsRegular() || nodePathExt(file.Name()) != ".jsonl" {
				continue
			}
			for _, message := range dataMaidParseChatFile(filepath.Join(folder, file.Name())) {
				if filterFn(message) {
					allChats = append(allChats, message)
				}
			}
		}
	}
	return allChats
}

// dataMaidParseAllMetadata is #parseAllMetadata: group definitions (both `chat_metadata` and the
// deprecated `past_metadata`), then the FIRST message of every group chat and character chat.
func dataMaidParseAllMetadata(directories startup.UserDirectories, filterFn func(map[string]any) bool) []map[string]any {
	allMetadata := make([]map[string]any, 0)
	groups, err := dataMaidOpenDirectory(directories["groups"])
	if err != nil {
		return nil
	}
	for _, entry := range groups {
		if !entry.Type().IsRegular() || nodePathExt(entry.Name()) != ".json" {
			continue
		}
		data, err := readNodeJSONFile(filepath.Join(directories["groups"], entry.Name()))
		if err != nil || data == nil {
			continue
		}
		if metadata, ok := dataMaidMapMember(data, "chat_metadata"); ok && filterFn(metadata) {
			allMetadata = append(allMetadata, metadata)
		}
		if past, ok := data["past_metadata"].(map[string]any); ok {
			for _, item := range past {
				if metadata, ok := item.(map[string]any); ok && filterFn(metadata) {
					allMetadata = append(allMetadata, metadata)
				}
			}
		}
	}
	appendFromChatFolder := func(messages []map[string]any) {
		if len(messages) == 0 {
			return
		}
		if metadata, ok := dataMaidMapMember(messages[0], "chat_metadata"); ok && filterFn(metadata) {
			allMetadata = append(allMetadata, metadata)
		}
	}
	groupChats, err := dataMaidOpenDirectory(directories["groupChats"])
	if err != nil {
		return nil
	}
	for _, entry := range groupChats {
		if !entry.Type().IsRegular() || nodePathExt(entry.Name()) != ".jsonl" {
			continue
		}
		appendFromChatFolder(dataMaidParseChatFile(filepath.Join(directories["groupChats"], entry.Name())))
	}
	chatDirectories, err := dataMaidOpenDirectory(directories["chats"])
	if err != nil {
		return nil
	}
	for _, directory := range chatDirectories {
		if !directory.IsDir() {
			continue
		}
		folder := filepath.Join(directories["chats"], directory.Name())
		files, err := dataMaidOpenDirectory(folder)
		if err != nil {
			return nil
		}
		for _, file := range files {
			if !file.Type().IsRegular() || nodePathExt(file.Name()) != ".jsonl" {
				continue
			}
			appendFromChatFolder(dataMaidParseChatFile(filepath.Join(folder, file.Name())))
		}
	}
	return allMetadata
}

// dataMaidParseChatFile is #parseChatFile: one JSON object per line, invalid lines dropped, and
// JSON values that are falsy (the pinned `.filter(Boolean)`) dropped as well.
func dataMaidParseChatFile(path string) []map[string]any {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	lines := strings.Split(string(content), "\n")
	messages := make([]map[string]any, 0, len(lines))
	for _, line := range lines {
		var value any
		if json.Unmarshal([]byte(line), &value) != nil {
			continue
		}
		if !dataMaidTruthy(value) {
			continue
		}
		if message, ok := value.(map[string]any); ok {
			messages = append(messages, message)
		}
	}
	return messages
}

func readNodeJSONFile(path string) (map[string]any, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var value any
	if json.Unmarshal(content, &value) != nil {
		// tryParse returns undefined, which every caller treats as "no data".
		return nil, nil
	}
	if object, ok := value.(map[string]any); ok {
		return object, nil
	}
	return nil, nil
}

// ---- JavaScript value helpers -----------------------------------------------------------------

func dataMaidTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	case string:
		return typed != ""
	default:
		return true
	}
}

func dataMaidIsArray(value any) bool {
	_, ok := value.([]any)
	return ok
}

func dataMaidMapMember(object map[string]any, name string) (map[string]any, bool) {
	value, exists := object[name]
	if !exists {
		return nil, false
	}
	member, ok := value.(map[string]any)
	return member, ok
}

func nodeStringMember(object map[string]any, name string) (string, bool) {
	value, exists := object[name]
	if !exists {
		return "", false
	}
	text, ok := value.(string)
	return text, ok
}
