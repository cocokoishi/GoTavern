package e2e

// SHARED OBSERVATION AND ASSERTION TYPES FOR THE SEEDED STATE-MACHINE LANE (alpha.16 M1/M3).
//
// This file exists so the LIVE driver (`scenario_state_machine_test.go`) and the TEETH self-test
// (`scenario_state_machine_teeth_test.go`) call the SAME comparator functions. A negative control that used a
// second, private comparator would prove nothing about the gate: the teeth would belong to a function no
// qualification run executes. Every assertion below is NAMED, and the teeth test asserts on those names.
//
// Each comparator takes REAL observables (parsed HTTP bodies, parsed disk bytes, SHA-256 digests, instance
// identity) and returns nil or one named error. "A 200 happened" is never the assertion: the status check is
// only the first step, and every operation additionally proves the ordered content, the persisted bytes, or the
// digest that the operation was supposed to produce.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cocokoishi/gotavern/internal/longlivedfixture"
)

// smActionEntry is one line of the machine-readable action log. It records the seed, the step in the recipe's
// declared operation plan, the route that was driven, the HTTP status and the before/after digests of the
// observable the step is about. It is a struct, not a map, so the JSONL artifact is byte-stable.
type smActionEntry struct {
	Seed         int64  `json:"seed"`
	Step         int    `json:"step"`
	Op           string `json:"op"`
	User         string `json:"user"`
	Method       string `json:"method"`
	Route        string `json:"route"`
	Status       int    `json:"status"`
	BeforeDigest string `json:"beforeDigest"`
	AfterDigest  string `json:"afterDigest"`
	JSONValid    bool   `json:"jsonValid"`
	Instance     int    `json:"instance"`
	Detail       string `json:"detail,omitempty"`
}

// smObservableDigest returns the stable digest form used in the action log.
func smObservableDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// smFileDigestOrAbsent digests a file, answering "absent" when it does not exist so a before/after pair can
// distinguish "the file appeared" from "the file was rewritten".
func smFileDigestOrAbsent(target string) (string, error) {
	body, err := os.ReadFile(target)
	if err != nil {
		if os.IsNotExist(err) {
			return "absent", nil
		}
		return "", err
	}
	return smObservableDigest(body), nil
}

// smCheckHTTPStatus is the first, weakest assertion: the route answered the expected code. It is always
// accompanied by a content assertion, because a 200 alone has never been evidence on this project.
func smCheckHTTPStatus(op, route string, got, want int) error {
	if got != want {
		return fmt.Errorf("http-status:%s:%s:%d!=%d", op, route, got, want)
	}
	return nil
}

// smCheckOrderedMessages compares the ORDERED message texts of a chat. It names a dropped message, an extra
// message and a swap distinctly, because those are different defects and the teeth self-test plants each one.
func smCheckOrderedMessages(want, got []string) error {
	for index, wanted := range want {
		if index >= len(got) {
			return fmt.Errorf("message-dropped:%d:%s", index, wanted)
		}
		if got[index] != wanted {
			return fmt.Errorf("message-order-swapped:%d:%s->%s", index, wanted, got[index])
		}
	}
	if len(got) > len(want) {
		return fmt.Errorf("message-extra:%d", len(got))
	}
	return nil
}

// smDecodeChatArray parses the array /api/chats/get answers and returns the ordered texts. A body that is not
// the expected array is named rather than silently treated as an empty chat.
func smDecodeChatArray(body string) ([]string, error) {
	var messages []map[string]any
	if err := json.Unmarshal([]byte(body), &messages); err != nil {
		return nil, fmt.Errorf("chat-response-not-json-array:%v", err)
	}
	texts := make([]string, 0, len(messages))
	for index, message := range messages {
		text, ok := message["mes"].(string)
		if !ok {
			return nil, fmt.Errorf("chat-response-message-%d-has-no-mes", index)
		}
		texts = append(texts, text)
	}
	return texts, nil
}

// smCheckJSONL proves every non-empty line of a JSONL document decodes. It names the line, because "the chat
// file is invalid" is not actionable.
func smCheckJSONL(document []byte) error {
	lines := strings.Split(string(document), "\n")
	for index, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if !json.Valid([]byte(line)) {
			return fmt.Errorf("jsonl-invalid:line-%d", index+1)
		}
	}
	return nil
}

// smCheckJSONDocument proves a document decodes.
func smCheckJSONDocument(document []byte) error {
	if !json.Valid(document) {
		return fmt.Errorf("json-invalid")
	}
	return nil
}

// smSettingsString extracts the serialized settings document from /api/settings/get's envelope. The envelope
// carries the settings as a JSON STRING (pinned sends `settings` as text), so a marker check must parse the
// envelope first; a substring search on the raw body would also match unrelated members.
func smSettingsString(body string) (string, error) {
	var envelope struct {
		Settings *string `json:"settings"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		return "", fmt.Errorf("settings-response-not-json:%v", err)
	}
	if envelope.Settings == nil {
		return "", fmt.Errorf("settings-response-missing-settings-member")
	}
	return *envelope.Settings, nil
}

// smCheckSettingsMarker asserts a marker is present (the operation's own account) or absent (any other
// account's marker). The two directions are named differently so a leak cannot masquerade as a missing write.
func smCheckSettingsMarker(settings, marker string, wantPresent bool) error {
	present := strings.Contains(settings, marker)
	if wantPresent && !present {
		return fmt.Errorf("settings-marker-missing:%s", marker)
	}
	if !wantPresent && present {
		return fmt.Errorf("settings-marker-leaked:%s", marker)
	}
	return nil
}

// smCheckCrossUserRead asserts a response fetched inside another account's session does not carry the subject's
// data. This is the E06 isolation assertion; it is a positive check that the foreign response is empty of the
// marker, not a check that the request failed (a read that returns 200 with a leak is the defect).
func smCheckCrossUserRead(foreignBody, marker string) error {
	if strings.Contains(foreignBody, marker) {
		return fmt.Errorf("cross-user-read-leaked:%s", marker)
	}
	return nil
}

// smCheckUnknownFileDigest asserts a file the product has no opinion about kept its SHA-256.
func smCheckUnknownFileDigest(role, want, got string) error {
	if want != got {
		return fmt.Errorf("unknown-file-mutated:%s", role)
	}
	return nil
}

// smCheckPrebootArtifacts proves the executed environment carries exactly the artifacts the seed's recipe
// declares (chat, unknown file, card, world book, preset), by re-reading them from the booted tree.
func smCheckPrebootArtifacts(seed int64, dataRoot string, recipe *longlivedfixture.SeededRecipe) error {
	paths := longlivedfixture.SeededSeedArtifactPaths(seed)
	for role, relative := range paths {
		body, err := os.ReadFile(filepath.Join(dataRoot, filepath.FromSlash(relative)))
		if err != nil {
			return fmt.Errorf("preboot-artifact-missing:%s:%d", role, seed)
		}
		if got := smObservableDigest(body); got != recipe.Preboot.Artifacts[role] {
			return fmt.Errorf("preboot-artifact-mismatch:%s:%d", role, seed)
		}
	}
	return nil
}

// smCheckActionPlan asserts the executed operation log is the recipe's declared plan, in order, with the
// declared step indices.
func smCheckActionPlan(recipe *longlivedfixture.SeededRecipe, entries []smActionEntry) error {
	if len(entries) != len(recipe.Recipe.Actions) {
		return fmt.Errorf("operation-plan-length:%d!=%d", len(entries), len(recipe.Recipe.Actions))
	}
	for index, wanted := range recipe.Recipe.Actions {
		if entries[index].Step != index {
			return fmt.Errorf("operation-plan-step:%d:%d", index, entries[index].Step)
		}
		if entries[index].Op != wanted {
			return fmt.Errorf("operation-plan-mismatch:%d:%s!=%s", index, wanted, entries[index].Op)
		}
		if entries[index].Status == 0 {
			return fmt.Errorf("operation-plan-status-missing:%d", index)
		}
	}
	return nil
}

// smCheckReproducible compares two executions of the SAME seed's operation plan. The digest comparison is the
// reproducibility claim: a sequence whose observables differ between two runs is not reproducible, whatever its
// statuses were.
func smCheckReproducible(seed int64, first, second []smActionEntry) error {
	if len(first) != len(second) {
		return fmt.Errorf("operation-sequence-not-reproducible:%d:length-%d!=%d", seed, len(first), len(second))
	}
	for index := range first {
		firstBytes, err := json.Marshal(first[index])
		if err != nil {
			return fmt.Errorf("operation-sequence-not-reproducible:%d:marshal", seed)
		}
		secondBytes, err := json.Marshal(second[index])
		if err != nil {
			return fmt.Errorf("operation-sequence-not-reproducible:%d:marshal", seed)
		}
		if string(firstBytes) != string(secondBytes) {
			return fmt.Errorf("operation-sequence-not-reproducible:%d:step-%d", seed, index)
		}
	}
	return nil
}

// smRestartWitness is what the driver observed before it killed the server object.
type smRestartWitness struct {
	Instance     int
	DataRoot     string
	UserMarkers  map[string]string // account -> settings marker written by that account
	PrebootSeed  int64
	PrebootChat  []string          // ordered texts of the preboot chat, as read BEFORE the restart
	UnknownFiles map[string]string // path relative to the data root -> sha256
}

// smRestartObservation is what the driver observed after booting a new server object on the same data root.
type smRestartObservation struct {
	Instance     int
	DataRoot     string
	UserSettings map[string]string // account -> serialized settings document
	PrebootChat  string            // raw /api/chats/get body for the witness seed
	UnknownFiles map[string]string // path relative to the data root -> sha256
}

// smCheckRestartResume asserts the restart was a restart of a NEW server object on the SAME data root, and that
// the persisted state a user would open came back: every account's settings marker, the preboot chat in order,
// and every unknown file's digest. A restart that reused the old instance, or booted a different root, is named
// distinctly from a resume that lost data.
func smCheckRestartResume(want smRestartWitness, got smRestartObservation) error {
	if got.Instance <= want.Instance {
		return fmt.Errorf("restart-instance-unchanged:%d", got.Instance)
	}
	if got.DataRoot != want.DataRoot {
		return fmt.Errorf("restart-data-root-mismatch:%s->%s", want.DataRoot, got.DataRoot)
	}
	for user, marker := range want.UserMarkers {
		settings, present := got.UserSettings[user]
		if !present {
			return fmt.Errorf("restart-settings-missing:%s", user)
		}
		if err := smCheckSettingsMarker(settings, marker, true); err != nil {
			return fmt.Errorf("restart-settings-marker-missing:%s", user)
		}
	}
	texts, err := smDecodeChatArray(got.PrebootChat)
	if err != nil || len(texts) == 0 {
		return fmt.Errorf("restart-preboot-chat-missing:%d", want.PrebootSeed)
	}
	if err := smCheckOrderedMessages(want.PrebootChat, texts); err != nil {
		return fmt.Errorf("restart-preboot-chat-order:%d:%v", want.PrebootSeed, err)
	}
	for relative, digest := range want.UnknownFiles {
		if gotDigest, present := got.UnknownFiles[relative]; !present || gotDigest != digest {
			return fmt.Errorf("restart-unknown-file-mutated:%s", relative)
		}
	}
	return nil
}
