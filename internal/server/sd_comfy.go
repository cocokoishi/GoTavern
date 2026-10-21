package server

// The comfy workflow CRUD routes, from src/endpoints/stable-diffusion.js:485-560.
//
// The pinned handlers use `fs.readdirSync`, `fs.readFileSync`, `writeFileAtomicSync`, `fs.unlinkSync`
// and `fs.renameSync` on `request.user.directories.comfyWorkflows`, which is `<dataRoot>/<handle>/user/
// workflows` (startup.storage.go USER_DIRECTORY_TEMPLATE). Their observable behaviour is recorded by
// tools/probe-sd-routes.mjs (`--workflows` mode) in
// tests/oracle/sillytavern-1.19.0-sd-workflows.json: 39 steps, each comparing the HTTP response and a
// full directory snapshot (name, kind and bytes) after the step.
//
// Writes go through the existing locked/atomic primitives rather than a second write path:
//   - save   -> startup.UpdateUserContentFile (per-user content lock + atomicReplace)
//   - delete -> startup.DeleteUserFile (same lock)
//   - rename -> the critical section of startup.UpdateUserContentFileIfChanged, which holds the
//     same lock while fs.renameSync's Go equivalent (os.Rename) runs. A rename has to be a
//     rename: the pinned operation moves directories too, and a write-then-delete would neither
//     be atomic nor able to move a directory.
//
// KNOWN DIFFERENCE, recorded in the routes fixture's knownDifferences and not hidden here: the
// pinned process has no try/catch around /api/sd/electronhub/sizes, so a rejected fetch there
// terminates the pinned server. GoTavern answers 500 and keeps serving.

import (
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// sdComfyWorkflowNames reproduces getComfyWorkflows (stable-diffusion.js:22):
// readdirSync, keep entries whose first character is not '.', case-insensitively ending in .json,
// sorted with `Intl.Collator().compare`.
func sdComfyWorkflowNames(directories startup.UserDirectories) ([]string, error) {
	entries, err := os.ReadDir(directories["comfyWorkflows"])
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if name == "" || name[0] == '.' {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(name), ".json") {
			continue
		}
		names = append(names, name)
	}
	// The probe refuses to record under a non-English default Intl locale; the pinned order is
	// Intl.Collator() with the default locale, which this CLDR-based collator reproduces for the
	// recorded names (including punctuation and case ordering).
	collator := collate.New(language.AmericanEnglish)
	sort.SliceStable(names, func(left, right int) bool {
		return collator.CompareString(names[left], names[right]) < 0
	})
	return names, nil
}

func sdStringArray(values []string) orderedNodeJSON {
	array := nodeArray()
	for _, value := range values {
		array.array = append(array.array, nodeString(value))
	}
	return array
}

// sdWorkflowPath is `path.join(request.user.directories.comfyWorkflows, sanitize(String(name)))`.
// The sanitizer removes both path separators, so the join cannot escape the directory; the empty
// sanitized name (for example file_name "/") addresses the directory itself, which is exactly the
// pinned behaviour and fails on write.
func sdWorkflowPath(directories startup.UserDirectories, name orderedNodeJSON) (string, bool) {
	text, err := pinnedJSStringValue(name)
	if err != nil {
		return "", false
	}
	return filepath.Join(directories["comfyWorkflows"], startup.SanitizeUserFilename(text)), true
}

// sdUserRelativePath is the path relative to the user root, in slash form, as the shared content
// primitives expect it.
func sdUserRelativePath(directories startup.UserDirectories, target string) (string, bool) {
	relative, err := filepath.Rel(directories["root"], target)
	if err != nil || relative == "" {
		return "", false
	}
	return filepath.ToSlash(relative), true
}

// serveSDComfyWorkflows is stable-diffusion.js:485.
func (runtime *accountRuntime) serveSDComfyWorkflows(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	// The handler never reads the body, but the pinned body parser still rejects a malformed
	// JSON body before the handler runs.
	if _, ok := runtime.sdRequestBody(w, request); !ok {
		return
	}
	names, err := sdComfyWorkflowNames(directories)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	respondOrderedNodeJSON(w, http.StatusOK, sdStringArray(names))
}

// serveSDComfyWorkflow is stable-diffusion.js:495: the file's text, JSON-stringified, falling
// back to Default_Comfy_Workflow.json when the requested file does not exist.
func (runtime *accountRuntime) serveSDComfyWorkflow(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	target, ok := sdWorkflowPath(directories, sdBodyMember(body, "file_name"))
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdFileExists(target) {
		target = filepath.Join(directories["comfyWorkflows"], "Default_Comfy_Workflow.json")
	}
	content, err := os.ReadFile(target)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	encoded, err := marshalNodeJSONString(string(content))
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	respondText(w, http.StatusOK, "text/html; charset=utf-8", string(encoded))
}

// serveSDComfySaveWorkflow is stable-diffusion.js:509: write the stringified workflow, then
// answer the new list. write-file-atomic writes `String(data)` and skips a null/undefined body,
// which is why a missing workflow creates an empty file.
func (runtime *accountRuntime) serveSDComfySaveWorkflow(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	target, ok := sdWorkflowPath(directories, sdBodyMember(body, "file_name"))
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	content := ""
	if data := sdBodyMember(body, "workflow"); !data.isNull() && !data.isUndefined() {
		text, err := pinnedJSStringValue(data)
		if err != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		content = text
	}
	relative, ok := sdUserRelativePath(directories, target)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if err := startup.UpdateUserContentFile(runtime.options.DataRoot, account.string("handle"), relative, func([]byte) ([]byte, error) {
		return []byte(content), nil
	}); err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	names, err := sdComfyWorkflowNames(directories)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	respondOrderedNodeJSON(w, http.StatusOK, sdStringArray(names))
}

// serveSDComfyDeleteWorkflow is stable-diffusion.js:521: delete when present, always answer 200.
func (runtime *accountRuntime) serveSDComfyDeleteWorkflow(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	target, ok := sdWorkflowPath(directories, sdBodyMember(body, "file_name"))
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	relative, ok := sdUserRelativePath(directories, target)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if _, err := startup.DeleteUserFile(runtime.options.DataRoot, account.string("handle"), relative); err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDStatus(w, http.StatusOK)
}

// serveSDComfyRenameWorkflow is stable-diffusion.js:534, including its two filename-validation
// middlewares and its 400/404/409/204 branches.
func (runtime *accountRuntime) serveSDComfyRenameWorkflow(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	if !sdValidateWorkflowFilename(w, body, "old_name") || !sdValidateWorkflowFilename(w, body, "new_name") {
		return
	}
	oldPath, ok := sdWorkflowPath(directories, sdBodyMember(body, "old_name"))
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	newPath, ok := sdWorkflowPath(directories, sdBodyMember(body, "new_name"))
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !strings.EqualFold(sdNodePathExtname(oldPath), ".json") || !strings.EqualFold(sdNodePathExtname(newPath), ".json") {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", "Only JSON workflow files are allowed")
		return
	}
	if !sdFileExists(oldPath) {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", "Workflow not found")
		return
	}
	if sdFileExists(newPath) {
		respondText(w, http.StatusConflict, "text/html; charset=utf-8", "A workflow with that name already exists")
		return
	}
	relative, ok := sdUserRelativePath(directories, oldPath)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// Run the rename inside the shared content lock's critical section so a concurrent save,
	// delete or startup write cannot interleave. The callback declines the write: the primitive
	// is used for its lock, and os.Rename is the same atomic operation atomicReplace performs.
	if err := startup.UpdateUserContentFileIfChanged(runtime.options.DataRoot, account.string("handle"), relative, func([]byte) ([]byte, bool, error) {
		return nil, false, os.Rename(oldPath, newPath)
	}); err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDStatus(w, http.StatusNoContent)
}

// sdValidateWorkflowFilename reproduces getFileNameValidationFunction(field)
// (src/middleware/validateFileName.js): reject with 400 when the field's string form contains the
// platform's forbidden path separator or NUL. The forbidden set itself is platform dependent:
// on POSIX only '/' and NUL; on Windows '\\' is also forbidden.
func sdValidateWorkflowFilename(w http.ResponseWriter, body orderedNodeJSON, field string) bool {
	if body.kind != 'o' {
		return true
	}
	value, exists := body.member(field)
	if !exists {
		return true
	}
	switch value.kind {
	case 's':
	case 'n', nodeUndefinedKind:
		// `hasToString` is false for null and undefined.
		return true
	case 'o':
		if _, hasToString := value.member("toString"); hasToString {
			// typeof value.toString !== 'function' for a JSON member.
			return true
		}
	}
	text, err := pinnedJSStringValue(value)
	if err != nil {
		return true
	}
	forbidden := "/\x00"
	if goruntime.GOOS == "windows" {
		forbidden = "/\x00\\"
	}
	if strings.ContainsAny(text, forbidden) {
		serveSDStatus(w, http.StatusBadRequest)
		return false
	}
	return true
}

// sdNodePathExtname is Node's path.extname for a sanitized bare filename: the extension begins at
// the last dot unless the basename starts with that dot, is all dots, or has no dot.
func sdNodePathExtname(name string) string {
	startPart := strings.LastIndexAny(name, `/\`) + 1
	dot := strings.LastIndexByte(name, '.')
	if dot < 0 || dot <= startPart {
		return ""
	}
	if strings.Trim(name[startPart:], ".") == "" {
		return ""
	}
	return name[dot:]
}

func sdFileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
